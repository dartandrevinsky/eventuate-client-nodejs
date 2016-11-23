import 'babel-polyfill';
import Rx from 'rx';
import Agent, { HttpsAgent } from 'agentkeepalive';
import urlUtils from 'url';
import uuid from 'uuid';
import http from 'http';
import https from 'https';
import path from 'path';
import invariant from 'invariant';

import Stomp from './stomp/Stomp';
import AckOrderTracker from './stomp/AckOrderTracker';
import { escapeStr, unEscapeStr } from './specialChars';
import EventuateServerError from './EventuateServerError';
import { getLogger } from './logger';
import Result from './Result';

const logger = getLogger({ title: 'EventuateClient' });

export default class EventuateClient {

  constructor({ apiKey, url, stompHost, stompPort, spaceName, httpKeepAlive, debug }) {


    this.apiKey = apiKey;
    this.url =  url;
    this.stompHost = stompHost;
    this.stompPort = stompPort;
    this.spaceName = spaceName;
    this.debug = debug;

    this.urlObj = urlUtils.parse(this.url);

    this.determineIfSecure();
    this.setupHttpClient();
    this.setupKeepAliveAgent(httpKeepAlive);

    this.baseUrlPath = '/entity';
    this.subscriptions = {};
    this.receipts = {};

    this.reconnectInterval = 500;
    this.reconnectIntervalStart = 500;

    this.stompClient = null;

    this.connectionCount = 0;
    this._connPromise = null;
  }

  determineIfSecure() {
    this.useHttps = (this.urlObj.protocol == 'https:');
  }

  setupHttpClient() {
    if (this.useHttps) {
      this.httpClient = https;
    } else {
      this.httpClient = http;
    }
  }

  setupKeepAliveAgent(httpKeepAlive) {

    if (this.httpKeepAlive ) {

      const keepAliveOptions = {
        maxSockets: 100,
        maxFreeSockets: 10,
        keepAlive: true,
        keepAliveMsecs: 60000 // keep-alive for 60 seconds
      };

      if (this.useHttps) {
        this.keepAliveAgent = new HttpsAgent(keepAliveOptions);
      } else {
        this.keepAliveAgent = new Agent(keepAliveOptions);
      }

    }
  }

  create(entityTypeName, _events, options, callback) {

    return new Promise((resolve, reject) => {

      if (!callback && typeof options == 'function') {
        callback = options;
      }

      const result = new Result({ resolve, reject, callback });
      //check input params
      if(!entityTypeName || !this.checkEvents(_events)) {
        return result.failure(new Error('Incorrect input parameters for create()'));
      }

      const events = this.prepareEvents(_events);
      const jsonData = {
        entityTypeName,
        events
      };

      this.addBodyOptions(jsonData, options);

      const urlPath = path.join(this.baseUrlPath, this.spaceName);

      _request(urlPath, 'POST', this.apiKey, jsonData, this, (err, httpResponse, jsonBody) => {

        if (err || (err = statusCodeError(httpResponse.statusCode, jsonBody))) {
          return result.failure(err);
        }

        const { entityId, entityVersion, eventIds} = jsonBody;

        if (!entityId || !entityVersion || !eventIds) {
          return result.failure({
            error: 'Bad server response',
            statusCode: httpResponse.statusCode,
            message: jsonBody
          });
        }

        result.success({
          entityIdTypeAndVersion: { entityId, entityVersion },
          eventIds
        });
      });

    });

  }

  loadEvents(entityTypeName, entityId, options, callback) {

    return new Promise((resolve, reject) => {

      if (!callback && typeof options == 'function') {
        callback = options;
      }

      const result = new Result({ resolve, reject, callback });

      //check input params
      if (!entityTypeName || !entityId) {
        return result.failure(new Error('Incorrect input parameters for loadEvents'));
      }

      let urlPath = path.join(this.baseUrlPath, this.spaceName, entityTypeName, entityId);

      urlPath += '?' + this.serialiseObject(options);

      _request(urlPath, 'GET', this.apiKey, null, this, (err, httpResponse, jsonBody) => {

        if (err || (err = statusCodeError(httpResponse.statusCode, jsonBody))) {
          return result.failure(err);
        }

        const events = this.eventDataToObject(jsonBody.events);

        result.success(events);
      });

    });
  }

  update(entityTypeName, entityId, entityVersion, _events, options, callback) {

    return new Promise((resolve, reject) => {

      if (!callback && typeof options == 'function') {
        callback = options;
      }

      const result = new Result({ resolve, reject, callback });

      //check input params
      if (!entityTypeName || !entityId || !entityVersion || !this.checkEvents(_events)) {
        return result.failure(new Error('Incorrect input parameters for update()'));
      }

      const events = this.prepareEvents(_events);
      const jsonData = {
        entityId,
        entityVersion,
        events
      };

      this.addBodyOptions(jsonData, options);

      const urlPath = path.join(this.baseUrlPath, this.spaceName, entityTypeName, entityId);

      _request(urlPath, 'POST', this.apiKey, jsonData, this, (err, httpResponse, jsonBody) => {

        if (err || (err = statusCodeError(httpResponse.statusCode, jsonBody))) {
          return result.failure(err);
        }

        const { entityId, entityVersion, eventIds} = jsonBody;

        if (!entityId || !entityVersion || !eventIds) {
          return result.failure({
            error: 'Bad server response',
            statusCode: httpResponse.statusCode,
            message: jsonBody
          });
        }

        result.success({
          entityIdTypeAndVersion: { entityId, entityVersion },
          eventIds
        });
      });
    });
  }

  subscribe(subscriberId, entityTypesAndEvents, options, callback) {

    if (!callback) {
      callback = options;
      options = undefined;
    }

    const ackOrderTracker = new AckOrderTracker();

    if (!subscriberId || !Object.keys(entityTypesAndEvents).length) {
      return callback(new Error('Incorrect input parameters'));
    }

    const createFn = this.observableCreateAndSubscribe(subscriberId, entityTypesAndEvents, ackOrderTracker, options, callback);

    const observable = Rx.Observable.create(createFn);

    const acknowledge = ack => {

      //logger.debug('acknowledge fn:', ack);

      ackOrderTracker.ack(ack).forEach(this.stompClient.ack.bind(this.stompClient));
    };

    return {
      acknowledge,
      observable
    };
  }

  observableCreateAndSubscribe(subscriberId, entityTypesAndEvents, ackOrderTracker, options, callback) {

    return observer => {

      const messageCallback = (body, headers) => {

        ackOrderTracker.add(headers.ack);

        body.forEach(eventStr => {

          const result = this.makeEvent(eventStr, headers.ack);

          if (result.error) {
            return observer.onError(result.error);
          }

          observer.onNext(result.event);
        });
      };

      this.addSubscription(subscriberId, entityTypesAndEvents, messageCallback, options, callback);

      this.connectToStompServer().then(
        () => {
          this.doClientSubscribe(subscriberId);
        },
        callback
      );
    };
  }

  addSubscription(subscriberId, entityTypesAndEvents, messageCallback, options, clientSubscribeCallback) {

    //add new subscription if not exists
    if (typeof this.subscriptions[subscriberId] == 'undefined') {
      this.subscriptions[subscriberId] = {};
    }

    const destinationObj = {
      entityTypesAndEvents,
      subscriberId
    };

    if (this.spaceName) {
      destinationObj.space = this.spaceName;
    }

    if (options) {
      destinationObj.durability = options.durability;
      destinationObj.readFrom = options.readFrom;
      destinationObj.progressNotifications = options.progressNotifications;
    }

    const destination = escapeStr(JSON.stringify(destinationObj));

    const uniqueId = uuid.v1().replace(new RegExp('-', 'g'), '');
    const id = `subscription-id-${uniqueId}`;
    const receipt = `receipt-id-${uniqueId}`;

    //add to receipts
    this.addReceipt(receipt, clientSubscribeCallback);

    this.subscriptions[subscriberId] = {
      subscriberId,
      entityTypesAndEvents,
      messageCallback,
      headers: {
        id,
        receipt,
        destination
      }
    };
  }

  connectToStompServer() {

    return this._connPromise || (this._connPromise = new Promise((resolve, reject) => {

        // Do not reconnect if self-invoked
        if (this.closed) {
          return reject();
        }

        const { stompPort: port, stompHost: host, useHttps: ssl, debug } = this;
        const { id: login, secret: passcode } = this.apiKey;
        const heartBeat = [5000, 5000];
        const timeout = 50000;
        const keepAlive = false;

        invariant(port && host && login && passcode && heartBeat && timeout, 'Incorrect STOMP connection parameters');
        const stompArgs = { port, host, login, passcode, heartBeat, timeout, keepAlive, ssl, debug };

        this.stompClient = new Stomp(stompArgs);
        this.stompClient.connect();

        this.stompClient.on('socketConnected', () => {

          //reset interval
          this.reconnectInterval = this.reconnectIntervalStart;
        });

        this.stompClient.on('connected', () => {

          resolve();
          this.connectionCount++;
        });

        this.stompClient.on('disconnected', () => {
          this.stompClient = null;
          this._connPromise = null;

          // Do not reconnect if self-invoked
          if (!this.closed) {

            if (this.reconnectInterval < 16000) {
              this.reconnectInterval = this.reconnectInterval * 2;
            }

            this.reconnectStompServer(this.reconnectInterval);
          }

        });

        this.stompClient.on('message', frame => {

          const headers = frame.headers;
          const body = frame.body;

          const ack = JSON.parse(unEscapeStr(headers.ack));

          const subscriberId = ack.receiptHandle.subscriberId;

          if (this.subscriptions.hasOwnProperty(subscriberId)) {
            //call message callback;
            this.subscriptions[subscriberId].messageCallback( body, headers);
          } else {
            logger.error(`Can't find massageCallback for subscriber: ${subscriberId}`);
          }
        });

        this.stompClient.on('receipt', receiptId => {

          if (this.receipts.hasOwnProperty(receiptId)) {
            //call Client.subscribe callback
            this.receipts[receiptId].clientSubscribeCallback(null, receiptId);
          }
        });

        this.stompClient.on('error', error => {
          logger.error('stompClient ERROR');
          logger.error(error);
        });

      }));
  }

  reconnectStompServer(interval) {
    logger.info('\nReconnecting...');
    logger.info(interval);

    setTimeout(() => {

      this.connectToStompServer()
        .then(() => {

          //resubscribe
          for (let subscriberId in this.subscriptions) {
            if (this.subscriptions.hasOwnProperty(subscriberId)) {
              this.doClientSubscribe(subscriberId);
            }

          }
        },
        error => {

          //run subscription callback
          for (let receipt in this.receipts) {
            if (this.receipts.hasOwnProperty(receipt)) {
              this.receipts[receipt].clientSubscribeCallback(error);
            }
          }

        }
      );
    }, interval);

  }

  addReceipt(receipt, clientSubscribeCallback) {

    if (typeof this.receipts[receipt] == 'undefined') {
      this.receipts[receipt] = {};
    }

    let receiptObj = this.receipts[receipt];

    receiptObj.clientSubscribeCallback = clientSubscribeCallback;
  }

  doClientSubscribe(subscriberId) {

    if (!this.subscriptions.hasOwnProperty(subscriberId)) {
      return logger.error(new Error(`Can't find subscription for subscriber ${subscriberId}`));
    }

    const subscription = this.subscriptions[subscriberId];

    this.stompClient.subscribe(subscription.headers);
  }

  disconnect() {

    logger.debug('disconnect()');

    this.closed = true;

    invariant(this._connPromise, 'Disconnect without connection promise spotted.');

    if (this.stompClient) {
      try {
        this.stompClient.disconnect();
      } catch (e) {
        logger.error(e);
      }
    }
  }

  makeEvent(eventStr, ack) {

    try {

      const { id: eventId, eventType, entityId, eventData: eventDataStr, swimlane, eventToken } = JSON.parse(eventStr);

      const eventData = JSON.parse(eventDataStr);

      const event = {
        eventId,
        eventType,
        entityId,
        swimlane,
        eventData,
        eventToken,
        ack
      };

      return { event };
    } catch (error) {
      return { error };
    }

  }

  serialiseObject(obj) {

    if (typeof obj == 'object') {
      return Object.keys(obj)
        .map(key => {
          return `${key}=${obj[key]}`;
        })
        .join('&');
    }
  }

  addBodyOptions (jsonData, options) {

    if (typeof options == 'object') {
      Object.keys(options).reduce((jsonData, key) => {

        jsonData[key] = options[key];

        return jsonData;
      }, jsonData);
    }
  }

  prepareEvents(events) {

    return events.map(({ eventData, ...rest } = event) => {

      if (typeof eventData == 'object') {
        eventData = JSON.stringify(eventData);
      }

      return {
        ...rest,
        eventData
      };
    });
  }

  eventDataToObject(events) {

    return events.map(e => {

      const event = Object.assign({}, e);

      if (typeof event.eventData != 'string') {
        return event;
      }

      try {
        event.eventData = JSON.parse(event.eventData);
      } catch (err) {
        logger.error('Can not parse eventData');
        logger.error(err);
        event.eventData = {};
      }

      return event;
    });
  }

  /**
   * Checks that events have all needed properties
   * Checks eventData
   * @param {Object[]} events - Events
   * @param {string} events[].eventType - The type of event
   * @param {string|Object} events[].eventData - The event data
   * @returns {Boolean}
   */
   checkEvents (events) {

    if (!Array.isArray(events) || !events.length) {
      return false;
    }

    return events.every(({ eventType, eventData }) => {

      if (!eventType || !eventData) {
        return false;
      }

      let ed;

      if (typeof eventData == 'string') {

        ed = eventData;
        //try to parse eventData
        try {
          ed = JSON.parse(ed);
        } catch(e) {
          return false;
        }
      } else if (typeof eventData == 'object') {
        ed = Object.assign({}, eventData);
      } else {
        return false;
      }

      if (Object.keys(ed).length === 0 ) {
        return false;
      }

      return true;

    });
  }
}


function statusCodeError(statusCode, message) {

  if (statusCode != 200) {

    return new EventuateServerError({
      error: `Server returned status code ${statusCode}`,
      statusCode,
      message
    });

  }
}

function _request(path, method, apiKey, jsonData, client, callback) {

  const auth = `Basic ${new Buffer(`${apiKey.id}:${apiKey.secret}`).toString('base64')}`;

  const headers = {
    'Authorization' : auth
  };

  let postData;
  if (method == 'POST') {
    postData = JSON.stringify(jsonData);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(postData, 'utf8');
  }

  const options = {
    host: client.urlObj.hostname,
    port: client.urlObj.port,
    path,
    method,
    headers
  };

  if (client.httpKeepAlive) {
    options.agent = client.keepAliveAgent;
  }

  const req = client.httpClient.request(options, res => {

    res.setEncoding('utf8');

    let responseData = '';

    res.on('data', chunk => {

      responseData += chunk;
    });

    res.on('end', () => {

      try {

        callback(null, res, JSON.parse(responseData));

      } catch (err) {
        callback(err);
      }

    })

  });

  req.on('error', err => {
    callback(err);
  });

  if (method == 'POST') {
    req.write(postData);
  }

  req.end();

  return req;
}