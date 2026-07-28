import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidCidr, normalizeCidr } from '../src/lib/cidr.js';

/**
 * These values end up in an API token's IP allowlist. Getting them wrong is
 * quiet and expensive in both directions: too permissive and a stolen token
 * still works from anywhere; too strict and a CI pipeline locks itself out
 * with no obvious cause.
 */

test('accepts plain IPv4 addresses and ranges', () => {
  for (const value of ['203.0.113.4', '10.0.0.0/8', '192.168.1.0/24', '0.0.0.0/0', '255.255.255.255/32']) {
    assert.equal(isValidCidr(value), true, value);
  }
});

test('accepts IPv6 addresses and ranges', () => {
  for (const value of ['::1', '2001:db8::/32', 'fe80::/10', '2001:0db8:0000:0000:0000:0000:0000:0001', '::/0']) {
    assert.equal(isValidCidr(value), true, value);
  }
});

test('rejects out-of-range octets and prefix lengths', () => {
  for (const value of ['256.0.0.1', '203.0.113.4/33', '203.0.113.4/999', '2001:db8::/129', '1.2.3.4/-1']) {
    assert.equal(isValidCidr(value), false, value);
  }
});

test('rejects malformed input rather than passing it to Postgres', () => {
  for (const value of [
    '', '/24', '1.2.3', '1.2.3.4.5', 'not-an-ip', 'localhost',
    '1.2.3.4/24/8', // more than one prefix
    '2001:db8::1::2', // two elisions
    '1.2.3.4 ', // stray whitespace
    'gggg::1', // non-hex group
    '12345::1', // group longer than four hex digits
    '1:2:3:4:5:6:7:8:9', // too many groups
    "1.2.3.4'; DROP TABLE api_tokens; --",
  ]) {
    assert.equal(isValidCidr(value), false, JSON.stringify(value));
  }
});

test('a bare address normalises to an explicit single host', () => {
  assert.equal(normalizeCidr('203.0.113.4'), '203.0.113.4/32');
  assert.equal(normalizeCidr('2001:db8::1'), '2001:db8::1/128');
  assert.equal(normalizeCidr('::1'), '::1/128');
});

test('an address that already carries a prefix is left alone', () => {
  for (const value of ['10.0.0.0/8', '2001:db8::/32', '0.0.0.0/0']) {
    assert.equal(normalizeCidr(value), value);
  }
});

test('everything valid stays valid after normalising', () => {
  // Normalisation runs before the value reaches the database, so it must not
  // turn an accepted value into one Postgres would reject.
  for (const value of ['203.0.113.4', '::1', '10.0.0.0/8', '2001:db8::/32']) {
    assert.equal(isValidCidr(normalizeCidr(value)), true, value);
  }
});
