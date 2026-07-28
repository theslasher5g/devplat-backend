import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, base32Encode, codeForStep, generateRecoveryCodes, otpauthUri, verifyTotp } from '../src/lib/totp.js';

/**
 * TOTP is hand-implemented on node:crypto (see src/lib/totp.ts for why), so it
 * is exactly the code that must not drift silently. These are the published
 * RFC 6238 vectors — if a refactor breaks the HMAC or the counter packing,
 * every customer's authenticator stops working at once.
 */

// RFC 6238 Appendix B uses this ASCII seed with 8-digit codes; we emit 6, so
// compare against the last six digits of each published value.
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET = base32Encode(RFC_SEED);

test('matches every RFC 6238 test vector', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    // Exercises the 64-bit counter path (step > 2^32 / 30).
    [20000000000, '65353130'],
  ];
  for (const [unixSeconds, expected8] of vectors) {
    const step = Math.floor(unixSeconds / 30);
    assert.equal(codeForStep(RFC_SECRET, step), expected8.slice(-6), `vector at t=${unixSeconds}`);
  }
});

test('base32 round-trips', () => {
  assert.equal(base32Decode(base32Encode(RFC_SEED)).toString('ascii'), '12345678901234567890');
});

test('accepts the current code and rejects a wrong one', () => {
  const now = 1111111109_000;
  const step = Math.floor(1111111109 / 30);
  assert.equal(verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, step), now).ok, true);
  assert.equal(verifyTotp(RFC_SECRET, '000000', now).ok, false);
});

test('tolerates one step of clock skew but no more', () => {
  const now = 1111111109_000;
  const step = Math.floor(1111111109 / 30);
  for (const offset of [-1, 0, 1]) {
    assert.equal(verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, step + offset), now).ok, true, `offset ${offset}`);
  }
  for (const offset of [-2, 2, 5]) {
    assert.equal(verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, step + offset), now).ok, false, `offset ${offset}`);
  }
});

test('reports the matched step so callers can block replays', () => {
  const now = 1111111109_000;
  const step = Math.floor(1111111109 / 30);
  assert.equal(verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, step), now).step, step);
});

test('rejects malformed input rather than throwing', () => {
  for (const bad of ['', 'abcdef', '12345', '1234567', '12 34 56x']) {
    assert.equal(verifyTotp(RFC_SECRET, bad).ok, false, `input ${JSON.stringify(bad)}`);
  }
});

test('otpauth URI carries the parameters authenticators expect', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'user@example.com');
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.host, 'totp');
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), 'devplat:user@example.com');
  assert.equal(parsed.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
});

test('recovery codes are unique and non-trivial', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, 'codes must not repeat');
  for (const c of codes) assert.match(c, /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  // Two separate draws must not collide — that would mean a broken RNG.
  assert.equal(new Set([...codes, ...generateRecoveryCodes()]).size, 20);
});
