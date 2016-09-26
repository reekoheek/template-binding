const assert = require('assert');
const Token = require('../src/token');

describe('Token', () => {
  describe('#value()', () => {
    it('return value of token if vary token', () => assert.equal(Token.get('foo').value({foo: 'bar'}), 'bar'));
    it('return number if number token', () => assert.strictEqual(Token.get('10').value(), 10));
    it('return bool if bool token', () => assert.strictEqual(Token.get(true).value(), true));
    it('return string if string token', () => assert.strictEqual(Token.get('"foo"').value(), 'foo'));
  });
});
