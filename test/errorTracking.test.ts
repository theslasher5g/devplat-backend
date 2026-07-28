import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../src/lib/errorFingerprint.js';

/**
 * The error table is read by platform admins and sits in every backup, so it
 * must not quietly become a second copy of the data it was meant to describe.
 * Error strings are built from whatever was in scope when things went wrong,
 * which is exactly when a token or an address ends up in one.
 */

test('strips API tokens', () => {
  const out = redact('invalid token dvp_live_9fA3kZq2XcV8 rejected');
  assert.ok(!out.includes('9fA3kZq2XcV8'), out);
  assert.match(out, /dvp_\[redacted\]/);
});

test('strips JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123';
  const out = redact(`jwt malformed: ${jwt}`);
  assert.ok(!out.includes('eyJzdWIiOiIxMjMifQ'), out);
  assert.match(out, /\[jwt\]/);
});

test('strips email addresses', () => {
  const out = redact('duplicate key for user ada.lovelace+dev@example.co.uk');
  assert.ok(!out.includes('ada.lovelace'), out);
  assert.match(out, /\[email\]/);
});

test('strips Stripe and webhook secrets', () => {
  for (const secret of ['sk_live_abcd1234efgh', 'whsec_abcd1234efgh', 'rk_test_abcd1234efgh']) {
    const out = redact(`stripe rejected ${secret}`);
    assert.ok(!out.includes('abcd1234efgh'), `${secret} → ${out}`);
    assert.match(out, /_\[redacted\]/);
  }
});

test('handles several secrets in one message', () => {
  const out = redact('user a@b.com token dvp_abc123def456 key sk_live_zzz99999');
  assert.ok(!out.includes('a@b.com'));
  assert.ok(!out.includes('abc123def456'));
  assert.ok(!out.includes('zzz99999'));
});

test('leaves an ordinary message alone', () => {
  const message = 'connect ECONNREFUSED 10.0.0.5:5432';
  assert.equal(redact(message), message);
});

test('does not mangle a stack trace', () => {
  const stack = 'Error: boom\n    at handler (/app/dist/src/routes/teams.js:42:11)';
  assert.equal(redact(stack), stack, 'file paths and line numbers must survive');
});
