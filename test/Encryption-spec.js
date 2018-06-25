'use strict';
const crypto = require('crypto');
const chai = require('chai');
const { expect } = chai;
chai.use(require('chai-string'));

const helpers = require('./lib/helpers');
const Encryption = require('../src/modules/Encryption');

const keyId = 'keyId';
// const keySecret = crypto.randomBytes(16).toString('hex');
const keySecret = '82ca495329e392e2984d2268ea9fda8c';
console.log('keySecret:', keySecret);
class EncryptionStore {
  constructor(keys) {
    this.keys = keys;
  }

  get(encryptionKeyId) {
    return Promise.resolve(this.keys[encryptionKeyId]);
  }
}
const encryptionKeyStore = new EncryptionStore({
  [keyId]: keySecret,
  '1': '7057a813a76cae4e87de5bef7fc2f9950014f68f88c501de044a861f39d309c1',
  '2': '666778b2a40a62284382c18976016d04a28cd0fc37beef04d00ec41512c4d7fd'
});
const encryptionPrefix = '__ENCRYPTED__';

const encryption = new Encryption(encryptionKeyStore);

describe('Encryption', () => {
  it('should check structure', () => {
    console.log('encryption:', encryption);
    expect(encryption).to.have.ownProperty('encryptionKeyStore');
    expect(encryption.encryptionKeyStore).to.deep.equal(encryptionKeyStore);
    expect(encryption.encrypt).to.be.a('function');
    expect(encryption.decrypt).to.be.a('function');
    expect(encryption.cipher).to.be.a('function');
    expect(encryption.decipher).to.be.a('function');
    expect(encryption.isEncrypted).to.be.a('function');
    expect(encryption.findKey).to.be.a('function');
  });

  it('isEncrypted() should return true', () => {
    const str = encryptionPrefix + 'abcde';
    expect(encryption.isEncrypted(str)).to.be.true;
  });

  it('isEncrypted() should return false', () => {
    const str = 'abcde';
    expect(encryption.isEncrypted(str)).to.be.false;
  });

  it('should find encryption key', done => {
    encryption.findKey(keyId)
      .then(key => {
        expect(key).to.equal(keySecret);
        done();
      })
      .catch(done);
  });

  it('should cipher and decipher', () => {
    const text = 'secret text';
    const iv = crypto.randomBytes(16).toString('hex').slice(0, 16);
    const cipher = encryption.cipher(keySecret, iv, text);
    const decipher = encryption.decipher(keySecret, iv, cipher);
    expect(decipher).to.equal(text);
  });

  it('should encrypt and decrypt', done => {
    const eventData = { a: '1', b: 2 };
    const eventDataString = JSON.stringify(eventData);
    console.log('Event data:', eventDataString);
    encryption.encrypt(keyId, eventDataString)
      .then(encryptedEventData => {
        console.log('encryptedEventData:', encryptedEventData);
        expect(encryptedEventData).startsWith(encryptionPrefix);
        const { salt } = JSON.parse(encryptedEventData.split(encryptionPrefix)[1]);
        const cipher = encryption.cipher(keySecret, salt, eventDataString);
        const expectedEncryptedEventData = `${encryptionPrefix}${JSON.stringify({ encryptionKeyId: keyId, data: cipher, salt })}`;
        expect(encryptedEventData).to.equal(expectedEncryptedEventData);

        return encryption.decrypt(encryptedEventData);
      })
      .then(decryptedEventData => {
        expect(decryptedEventData).to.equal(eventDataString);
        done();
      })
      .catch(done);
  });

  it('should try to encrypt with not existing key', done => {
    const eventData = '{ "foo": "bar" }';
    encryption.encrypt(eventData)
      .then(() => {
        done(new Error('Should return error'));
      })
      .catch(error => {
        helpers.expectEntityDeletedError(error);
        done();
      })
  });

  it('should try to decrypt with not existing key', done => {
    const encryptedEventData = '__ENCRYPTED__{"encryptionKeyId":"notExistingKeyId","data":"7e735ffcb85082731198f779e9d5b180"}';
    encryption.decrypt(encryptedEventData)
      .then(() => {
        done(new Error('Should return error'));
      })
      .catch(error => {
        helpers.expectEntityDeletedError(error);
        done();
      });
  });

  it('should decrypt Java version event data with salt', done => {

    const encryptedEventData = '__ENCRYPTED__{"encryptionKeyId":"1","data":"464cfd06fa01add009a7060e88a0070db45400e476b124f4f877f53039691567","salt":"7aefb227b2ea914443c16ad6d3994ae8"}';
    encryption.decrypt(encryptedEventData)
      .then(decrypted => {
        console.log(decrypted);
        done();
      })
      .catch(err => {
        done(err)
      })
  });

  it('should decrypt Java version event data without salt', done => {

    const encryptedEventData = '__ENCRYPTED__{"encryptionKeyId":"2","data":"a793ab10b5cb9c6e35780be18def1c1c2b64fb206a0aeb78664932fc98c36239"}';
    encryption.decrypt(encryptedEventData)
      .then(decrypted => {
        console.log(decrypted);
        done();
      })
      .catch(err => {
        done(err)
      })
  });

  it('should decrypt Node.js version event data without salt', done => {

    const encryptedEventData = '__ENCRYPTED__{"encryptionKeyId":"keyId","data":"9846141fa5f08f70b4f1f9c4d552ddb3"}';
    encryption.decrypt(encryptedEventData)
      .then(decrypted => {
        console.log(decrypted);
        done();
      })
      .catch(err => {
        done(err)
      })
  });

  it('should cipher simple string', () => {
    const key = '1a1bc5648c0c95a095761a2e633b15ff';
    const iv = crypto.randomBytes(16).toString('hex').slice(0, 16);
    const text = '1';
    const encrypted = encryption.cipher(key, iv, text);
    console.log('encrypted:', encrypted);
  })
});

