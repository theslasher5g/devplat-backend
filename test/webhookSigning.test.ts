import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { generateWebhookSecret, isWebhookEvent, signPayload, verifySignature, WEBHOOK_EVENTS } from '../src/lib/webhookSignature.js';

/**
 * The signature is the only thing standing between a customer's webhook
 * receiver and anyone on the internet who knows its URL. It is verified by
 * *their* code against *our* documentation, so the format has to be exactly
 * what the docs describe — verified here independently rather than by calling
 * our own signer twice, which would agree with itself no matter what it did.
 */

const SECRET = 'whsec_test_secret_value';
const BODY = JSON.stringify({ id: 'evt_1', type: 'environment.assigned' });

test('signature matches an independent HMAC over "timestamp.body"', () => {
  const t = 1_780_000_000;
  const header = signPayload(SECRET, BODY, t);

  const expected = createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex');
  assert.equal(header, `t=${t},v1=${expected}`);
});

test('accepts its own fresh signature', () => {
  const t = Math.floor(Date.now() / 1000);
  assert.equal(verifySignature(SECRET, BODY, signPayload(SECRET, BODY, t), 300, t), true);
});

test('rejects a tampered body', () => {
  const t = Math.floor(Date.now() / 1000);
  const header = signPayload(SECRET, BODY, t);
  const tampered = JSON.stringify({ id: 'evt_1', type: 'environment.failed' });
  assert.equal(verifySignature(SECRET, tampered, header, 300, t), false);
});

test('rejects the wrong secret', () => {
  const t = Math.floor(Date.now() / 1000);
  assert.equal(verifySignature('whsec_other', BODY, signPayload(SECRET, BODY, t), 300, t), false);
});

test('rejects a replayed delivery once it is outside the tolerance', () => {
  // The point of putting the timestamp inside the signed material: a captured
  // payload replayed later must not still verify.
  const signedAt = 1_780_000_000;
  const header = signPayload(SECRET, BODY, signedAt);
  assert.equal(verifySignature(SECRET, BODY, header, 300, signedAt + 60), true, 'still fresh');
  assert.equal(verifySignature(SECRET, BODY, header, 300, signedAt + 3600), false, 'an hour later');
});

test('rejects a timestamp moved to make an old signature look fresh', () => {
  const signedAt = 1_780_000_000;
  const header = signPayload(SECRET, BODY, signedAt);
  const mac = header.split('v1=')[1];
  const forged = `t=${signedAt + 3600},v1=${mac}`;
  // Rewriting t invalidates the MAC, because t is part of what was signed.
  assert.equal(verifySignature(SECRET, BODY, forged, 300, signedAt + 3600), false);
});

test('rejects malformed headers instead of throwing', () => {
  const t = Math.floor(Date.now() / 1000);
  for (const header of ['', 'garbage', 't=abc,v1=def', `t=${t}`, `t=${t},v1=`, `t=${t},v1=zz`]) {
    assert.equal(verifySignature(SECRET, BODY, header, 300, t), false, header);
  }
});

test('secrets are unique and prefixed', () => {
  const a = generateWebhookSecret();
  const b = generateWebhookSecret();
  assert.notEqual(a, b);
  assert.match(a, /^whsec_[A-Za-z0-9_-]{43}$/);
});

test('event names are validated against the published list', () => {
  for (const e of WEBHOOK_EVENTS) assert.equal(isWebhookEvent(e), true, e);
  for (const e of ['environment.started', 'anything', '']) assert.equal(isWebhookEvent(e), false, e);
});
