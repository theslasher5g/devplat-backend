import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeAlertSubject, sanitizeRoute } from '../src/lib/sanitize.js';

/**
 * Alert subjects are assembled from values that arrive from outside. POST
 * /client-errors is public by necessity — a browser whose page just crashed has
 * no session — and its `route` reaches the subject of a mail the operator reads
 * in their own inbox. Reproduced against a running server before this existed:
 * 25 anonymous reports carrying a newline in `route` put a second, attacker-
 * written line into that subject.
 *
 * Two layers, failing differently. sanitizeAlertSubject protects every alert,
 * including ones not written yet; sanitizeRoute keeps the stored value honest.
 */

test('a newline cannot open a second line in a subject', () => {
  const s = sanitizeAlertSubject('Client error — /app\nURGENT: verify at https://evil.example');
  assert.ok(!/[\r\n]/.test(s), s);
});

test('carriage returns and tabs go the same way', () => {
  assert.ok(!/[\r\n\t]/.test(sanitizeAlertSubject('a\r\nb\tc')));
});

test('ANSI escapes cannot colour a terminal tailing the logs', () => {
  // eslint-disable-next-line no-control-regex
  assert.ok(!//.test(sanitizeAlertSubject('host [31mdown[0m')));
});

test('runs of whitespace collapse rather than padding the line out', () => {
  assert.equal(sanitizeAlertSubject('Host    alpha      offline'), 'Host alpha offline');
});

test('a very long subject is truncated with a marker', () => {
  const s = sanitizeAlertSubject('x'.repeat(500));
  assert.ok(s.length <= 160, `length ${s.length}`);
  assert.ok(s.endsWith('…'), s.slice(-10));
});

test('an ordinary subject is left alone', () => {
  const raw = 'New api error — GET /environments';
  assert.equal(sanitizeAlertSubject(raw), raw);
});

test('a subject that is only control characters does not become garbage', () => {
  assert.equal(sanitizeAlertSubject('\n\r\t'), '');
});

/* ---- route ---- */

test('a real route survives intact', () => {
  assert.equal(sanitizeRoute('/app/billing'), '/app/billing');
  assert.equal(sanitizeRoute('/teams/me/invites'), '/teams/me/invites');
});

test('query strings and encodings survive', () => {
  assert.equal(sanitizeRoute('/app?tab=usage&days=30'), '/app?tab=usage&days=30');
  assert.equal(sanitizeRoute('/app/%20thing'), '/app/%20thing');
});

test('spaces become underscores so prose cannot read as prose', () => {
  const r = sanitizeRoute('/app URGENT your account is suspended');
  assert.ok(!/ /.test(r), r);
  assert.match(r, /^\/app_/);
});

test('a route is bounded well below the subject limit', () => {
  assert.ok(sanitizeRoute('/' + 'a'.repeat(500)).length <= 120);
});

test('an empty result is labelled rather than left blank', () => {
  // A subject reading "error — " with nothing after it looks like a bug in the
  // alerting, which is the last thing an alert should look like.
  assert.equal(sanitizeRoute('   '), '_');
  assert.equal(sanitizeRoute(''), '(unknown)');
});

test('the two layers compose: a hostile route cannot break the framing', () => {
  const route = sanitizeRoute('/app\nURGENT: verify at https://evil.example');
  const subject = sanitizeAlertSubject(`Widespread client error (25×) — ${route}`);
  assert.ok(!/[\r\n]/.test(subject));
  assert.match(subject, /^Widespread client error \(25×\) — /);
  const routePart = subject.split('— ')[1];
  assert.ok(!/ /.test(routePart), `route part reads as prose: ${routePart}`);
});
