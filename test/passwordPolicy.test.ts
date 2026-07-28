import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { PASSWORD_MIN_LENGTH, breachCount, checkPassword, validatePasswordPolicy } from '../src/lib/passwordPolicy.js';

/**
 * The policy is the thing standing between a user and a password that shows up
 * in the next credential-stuffing run, so both halves get pinned: the local
 * complexity rules, and the HIBP k-anonymity lookup (with fetch stubbed — a
 * test suite must not depend on a third party being up).
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replaces fetch with one that returns a fixed HIBP range body. */
function stubHibp(body: string, ok = true): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return { ok, text: async () => body } as Response;
  }) as typeof fetch;
  return { calls };
}

/** The SHA-1 suffix HIBP would return for a password, as it formats it. */
function hibpSuffix(password: string): string {
  return createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase().slice(5);
}

test('accepts a password that meets every rule', () => {
  assert.deepEqual(validatePasswordPolicy('Correct-Horse9!'), []);
});

test('names each missing requirement', () => {
  const cases: [string, string][] = [
    ['Sh0rt!', 'at least'],
    ['alllowercase9!', 'uppercase'],
    ['ALLUPPERCASE9!', 'lowercase'],
    ['NoDigitsHere!!', 'number'],
    ['NoSpecials1234', 'special character'],
  ];
  for (const [password, expected] of cases) {
    const problems = validatePasswordPolicy(password);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `${JSON.stringify(password)} should be rejected for "${expected}", got ${JSON.stringify(problems)}`,
    );
  }
});

test('the minimum length is actually enforced at the boundary', () => {
  const eleven = 'Aa1!bcdefgh'; // 11 chars, otherwise valid
  assert.equal(eleven.length, PASSWORD_MIN_LENGTH - 1);
  assert.ok(validatePasswordPolicy(eleven).some((p) => p.includes('at least')));
  assert.deepEqual(validatePasswordPolicy(`${eleven}i`), []);
});

test('rejects absurdly long input instead of hashing it', () => {
  // bcrypt truncates at 72 bytes anyway; the cap is there so a megabyte of
  // input can't be used to make the hash step expensive.
  assert.ok(validatePasswordPolicy(`Aa1!${'x'.repeat(500)}`).some((p) => p.includes('at most')));
});

test('treats non-ASCII punctuation as a special character', () => {
  // A German or French keyboard shouldn't be second-class here.
  assert.deepEqual(validatePasswordPolicy('Straße9Größer§'), []);
});

test('a space alone does not satisfy the special-character rule', () => {
  assert.ok(validatePasswordPolicy('Passphrase 1234').some((p) => p.includes('special character')));
});

test('breachCount sends only the 5-character hash prefix', async () => {
  const stub = stubHibp('');
  await breachCount('Correct-Horse9!');
  assert.equal(stub.calls.length, 1);
  const sent = stub.calls[0]!;
  assert.ok(sent.startsWith('https://api.pwnedpasswords.com/range/'), sent);
  const prefix = sent.split('/').pop()!;
  assert.match(prefix, /^[0-9A-F]{5}$/);
  // The full hash — and so the password — must never appear in the URL.
  const full = createHash('sha1').update('Correct-Horse9!', 'utf8').digest('hex').toUpperCase();
  assert.equal(prefix, full.slice(0, 5));
  assert.ok(!sent.includes(full.slice(5)), 'the suffix must stay local');
});

test('breachCount reports the count for a matching suffix', async () => {
  const password = 'Correct-Horse9!';
  stubHibp(`0000000000000000000000000000000000A:3\r\n${hibpSuffix(password)}:4271\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1`);
  assert.equal(await breachCount(password), 4271);
});

test('breachCount does not match on a partial suffix', async () => {
  // The response is line-oriented; a naive `body.includes(suffix)` would also
  // fire on a longer line that merely contains it. This is the guard for that.
  const password = 'Correct-Horse9!';
  const suffix = hibpSuffix(password);
  stubHibp(`${suffix}ABC:9\r\nZZ${suffix}:9`);
  assert.equal(await breachCount(password), 0);
});

test('breachCount fails open when HIBP is unhappy or unreachable', async () => {
  stubHibp('anything', false); // non-200
  assert.equal(await breachCount('Correct-Horse9!'), 0);

  globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
  assert.equal(await breachCount('Correct-Horse9!'), 0);
});

test('checkPassword rejects a breached password with an actionable message', async () => {
  const password = 'Correct-Horse9!';
  stubHibp(`${hibpSuffix(password)}:120000`);
  const err = await checkPassword(password);
  assert.match(String(err), /data breach/i);
});

test('checkPassword skips the network call when the policy already fails', async () => {
  const stub = stubHibp('');
  const err = await checkPassword('short');
  assert.ok(err, 'a weak password must be rejected');
  assert.equal(stub.calls.length, 0, 'no reason to ask HIBP about a password we already refused');
});

test('checkPassword returns null for a strong, unbreached password', async () => {
  stubHibp('0000000000000000000000000000000000A:3');
  assert.equal(await checkPassword('Correct-Horse9!'), null);
});
