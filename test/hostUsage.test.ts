import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USAGE_STALE_AFTER_MS, presentHostUsage } from '../src/lib/hostUsage.js';

/**
 * "Is this measurement usable" is the rule that decides whether a host looks
 * unmeasured or looks idle-with-room. Get it wrong in the permissive direction
 * and the scheduler will eventually pile every VM onto whichever host stopped
 * reporting — which is, by definition, the host least able to say no.
 */

const NOW = Date.parse('2026-07-29T12:00:00Z');

function columns(overrides: Record<string, unknown> = {}) {
  return {
    ram_committed_mb: 16384,
    ram_granted_mb: 12288,
    ram_guest_used_mb: 5000,
    ram_host_available_mb: 40000,
    cpu_busy_pct: 35,
    cpu_used_actual: '2.75',
    cpu_throttled_vms: 1,
    usage_reported_at: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  } as Parameters<typeof presentHostUsage>[0];
}

test('a host that never reported is null, not zero', () => {
  // Zeroes would read as "idle with everything free" — the most attractive
  // possible host for the next placement, and the least true.
  assert.equal(presentHostUsage(columns({ usage_reported_at: null }), NOW), null);
});

test('fresh measurements are passed through', () => {
  const u = presentHostUsage(columns(), NOW);
  assert.ok(u);
  assert.equal(u.stale, false);
  assert.equal(u.ramCommittedMb, 16384);
  assert.equal(u.ramGuestUsedMb, 5000);
  assert.equal(u.cpuBusyPct, 35);
});

test('numeric columns arrive as strings and are converted', () => {
  // node-postgres hands numeric() over as a string rather than silently losing
  // precision. Left as-is it would flow into the UI and be rendered — or worse,
  // compared — as text.
  const u = presentHostUsage(columns({ cpu_used_actual: '2.75' }), NOW);
  assert.equal(u?.cpuUsedActual, 2.75);
  assert.equal(typeof u?.cpuUsedActual, 'number');
});

test('reclaimed memory is derived, not left to the reader', () => {
  const u = presentHostUsage(columns({ ram_committed_mb: 16384, ram_granted_mb: 12288 }), NOW);
  assert.equal(u?.ramReclaimedMb, 4096);
});

test('reclaimed is null when either side is missing', () => {
  // Subtracting from an absent value would produce a confident number out of
  // nothing.
  assert.equal(presentHostUsage(columns({ ram_granted_mb: null }), NOW)?.ramReclaimedMb, null);
  assert.equal(presentHostUsage(columns({ ram_committed_mb: null }), NOW)?.ramReclaimedMb, null);
});

test('reclaimed never goes negative', () => {
  // Granted above committed shouldn't happen, but the arithmetic must not
  // report "-512 MB reclaimed" if the two ever disagree mid-update.
  const u = presentHostUsage(columns({ ram_committed_mb: 8192, ram_granted_mb: 8704 }), NOW);
  assert.equal(u?.ramReclaimedMb, 0);
});

test('measurements past the staleness window are flagged', () => {
  // The specific failure: an agent stops reporting and its last values sit in
  // the row looking current forever.
  const old = new Date(NOW - USAGE_STALE_AFTER_MS - 1_000).toISOString();
  const u = presentHostUsage(columns({ usage_reported_at: old }), NOW);
  assert.ok(u);
  assert.equal(u.stale, true);
  // The values are still returned — the dashboard shows them greyed out with
  // their age rather than hiding them, because "40 GB free as of an hour ago"
  // is useful to a human and useless to a scheduler.
  assert.equal(u.ramGuestUsedMb, 5000);
});

test('stale is distinct from absent', () => {
  // A host running an older agent (null) and a host whose agent died (stale)
  // need different words in the UI and get the same treatment from placement.
  const stale = presentHostUsage(columns({ usage_reported_at: new Date(NOW - 10 * 60_000).toISOString() }), NOW);
  const absent = presentHostUsage(columns({ usage_reported_at: null }), NOW);
  assert.equal(absent, null);
  assert.equal(stale?.stale, true);
});

test('a Date instance is accepted as well as a string', () => {
  // node-postgres returns timestamptz as a Date; a JSON round-trip yields a
  // string. Both reach this function depending on the call site.
  const u = presentHostUsage(columns({ usage_reported_at: new Date(NOW - 1000) }), NOW);
  assert.equal(u?.stale, false);
});

test('partially reported usage keeps the fields that exist', () => {
  // CPU and memory arrive from independent sources on the agent: host busy time
  // needs no guest to answer, the memory block needs all of them to. A host
  // reporting one and not the other is normal, not an error.
  const u = presentHostUsage(columns({
    ram_committed_mb: null, ram_granted_mb: null, ram_guest_used_mb: null, ram_host_available_mb: null,
  }), NOW);
  assert.ok(u);
  assert.equal(u.ramGuestUsedMb, null);
  assert.equal(u.cpuBusyPct, 35);
});
