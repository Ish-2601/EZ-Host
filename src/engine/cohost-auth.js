const crypto = require('crypto');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  let bits = 0, value = 0;
  const out = [];
  for (const char of String(input).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error('Invalid authenticator secret');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function createTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, supplied) {
  const value = String(supplied || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(value)) return false;
  const now = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((offset) => {
    const expected = Buffer.from(totp(secret, now + offset));
    const actual = Buffer.from(value);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function checkPassword(password, account) {
  const actual = Buffer.from(hashPassword(password, account.salt).hash, 'hex');
  const expected = Buffer.from(account.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { createTotpSecret, totp, verifyTotp, hashPassword, checkPassword };
