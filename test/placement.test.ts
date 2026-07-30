import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USAGE_STALE_AFTER_MS } from '../src/lib/hostUsage.js';
import { fits, loadScore, measurementFresh, rankHosts, type PlacementHost } from '../src/scheduler/placement.js';

/**
 * Placement decides which machine a customer's environment lands on. Getting it
 * wrong is not subtle: send everything to one host and its tenants contend for
 * CPU while the rest of the fleet idles.
 *
 * The trap these tests exist for is the unmeasured host. Scoring "no data" as
 * "no load" would make every host running an older agent — and every host whose
 * agent just died — the most attractive target on the platform.
 */

const NOW = Date.parse('2026-07-30T12:00:00Z');
const fresh = new Date(NOW - 10_000).toISOString();
const stale = new Date(NOW - USAGE_STALE_AFTER_MS - 1_000).toISOString();

function host(over: Partial<PlacementHost> & { name: string }): PlacementHost {
  return {
    cpu_total: 16,
    cpu_used: 0,
    ram_total_mb: 65_536,
    ram_used_mb: 0,
    cpu_busy_pct: null,
    ram_host_available_mb: null,
    usage_reported_at: null,
    ...over,
  };
}

test('a host with no measurement is scored by its reservations, not as idle', () => {
  // Half its CPU is committed. Before measurement existed that was the whole
  // signal, and it stays the fallback.
  const h = host({ name: 'legacy', cpu_total: 16, cpu_used: 8 });
  assert.equal(loadScore(h, NOW), 50);
});

test('an unmeasured empty host is not preferred over a measured busy-but-emptier one arbitrarily', () => {
  // Both score 0 by their own evidence; the tiebreak is contractual room.
  const unmeasured = host({ name: 'a-unmeasured', cpu_total: 16, cpu_used: 0 });
  const measured = host({ name: 'b-measured', cpu_total: 32, cpu_used: 0, cpu_busy_pct: 0, usage_reported_at: fresh });
  const [first] = rankHosts([unmeasured, measured], 2, 4096, NOW);
  assert.equal(first.name, 'b-measured', 'the host with more free CPU should win the tiebreak');
});

test('a measured idle host beats a reservation-heavy one', () => {
  // The whole point. Eight VMs are committed on `busy-on-paper` but the silicon
  // is at 4%; `reserved-free` has nothing running but is genuinely at 70%.
  const idleButCommitted = host({
    name: 'busy-on-paper', cpu_total: 16, cpu_used: 12, cpu_busy_pct: 4, usage_reported_at: fresh,
  });
  const freeButHot = host({
    name: 'reserved-free', cpu_total: 16, cpu_used: 2, cpu_busy_pct: 70, usage_reported_at: fresh,
  });
  const [first] = rankHosts([freeButHot, idleButCommitted], 2, 4096, NOW);
  assert.equal(first.name, 'busy-on-paper');
});

test('a stale measurement is ignored in favour of reservations', () => {
  // An agent that died at 2% busy leaves 2% sitting in the row forever. Trusting
  // it would funnel every new VM at a host nobody can see.
  const dead = host({
    name: 'dead-agent', cpu_total: 16, cpu_used: 14, cpu_busy_pct: 2, usage_reported_at: stale,
  });
  assert.equal(measurementFresh(dead, NOW), false);
  assert.equal(loadScore(dead, NOW), 87.5);

  const healthy = host({
    name: 'healthy', cpu_total: 16, cpu_used: 8, cpu_busy_pct: 40, usage_reported_at: fresh,
  });
  const [first] = rankHosts([dead, healthy], 2, 4096, NOW);
  assert.equal(first.name, 'healthy');
});

test('measurement exactly at the staleness boundary still counts', () => {
  const edge = host({
    name: 'edge', cpu_busy_pct: 5,
    usage_reported_at: new Date(NOW - USAGE_STALE_AFTER_MS).toISOString(),
  });
  assert.equal(measurementFresh(edge, NOW), true);
});

test('a reported busy percentage with no timestamp is not trusted', () => {
  const h = host({ name: 'no-clock', cpu_total: 16, cpu_used: 16, cpu_busy_pct: 1 });
  assert.equal(measurementFresh(h, NOW), false);
});

test('reservations still gate entitlement — measurement never widens capacity', () => {
  // The agent admits against reserved capacity. A host at 1% busy with no
  // contractual room must not be offered work the agent will refuse.
  const full = host({
    name: 'full', cpu_total: 4, cpu_used: 4, ram_total_mb: 8192, ram_used_mb: 8192,
    cpu_busy_pct: 1, usage_reported_at: fresh,
  });
  assert.equal(fits(full, 1, 1024), false);
  assert.deepEqual(rankHosts([full], 1, 1024, NOW), []);
});

test('RAM is part of the fit test, not just CPU', () => {
  const cpuRichRamPoor = host({
    name: 'ram-poor', cpu_total: 32, cpu_used: 0, ram_total_mb: 4096, ram_used_mb: 3072,
  });
  assert.equal(fits(cpuRichRamPoor, 2, 2048), false);
  assert.equal(fits(cpuRichRamPoor, 2, 1024), true);
});

test('small load differences do not reshuffle the order', () => {
  // 41% and 43% are the same machine two seconds apart. If they ordered
  // differently, two placements a moment apart would land on different hosts for
  // no reason, concentrating work wherever the sample happened to dip.
  const a = host({ name: 'a', cpu_total: 16, cpu_used: 2, cpu_busy_pct: 41, usage_reported_at: fresh });
  const b = host({ name: 'b', cpu_total: 16, cpu_used: 8, cpu_busy_pct: 43, usage_reported_at: fresh });
  const [first] = rankHosts([b, a], 2, 4096, NOW);
  assert.equal(first.name, 'a', 'within one bucket, free CPU decides — and a has more');
});

test('a genuinely large load difference does reorder', () => {
  const hot = host({ name: 'a-hot', cpu_total: 16, cpu_used: 0, cpu_busy_pct: 90, usage_reported_at: fresh });
  const cool = host({ name: 'b-cool', cpu_total: 16, cpu_used: 10, cpu_busy_pct: 10, usage_reported_at: fresh });
  const [first] = rankHosts([hot, cool], 2, 4096, NOW);
  assert.equal(first.name, 'b-cool');
});

test('ordering is stable for identical hosts', () => {
  // Without a final tiebreak the order would depend on the row order Postgres
  // happened to return, which makes any capacity bug unreproducible.
  const hosts = [host({ name: 'zeta' }), host({ name: 'alpha' }), host({ name: 'mid' })];
  assert.deepEqual(
    rankHosts(hosts, 1, 1024, NOW).map((h) => h.name),
    ['alpha', 'mid', 'zeta'],
  );
});

test('a nonsensical busy percentage cannot poison the order', () => {
  // A bad agent build reporting 3000 or NaN must be clamped, not allowed to
  // sort a host to a position no real value could reach.
  const absurd = host({ name: 'absurd', cpu_busy_pct: 3000, usage_reported_at: fresh });
  const negative = host({ name: 'negative', cpu_busy_pct: -50, usage_reported_at: fresh });
  assert.equal(loadScore(absurd, NOW), 100);
  assert.equal(loadScore(negative, NOW), 0);
});

test('a host reporting zero CPUs is treated as unusable rather than idle', () => {
  const broken = host({ name: 'broken', cpu_total: 0, cpu_used: 0 });
  assert.equal(loadScore(broken, NOW), 100);
});

test('a host with no measurement columns at all behaves as before measurement existed', () => {
  // Rows from an older schema/agent: the fields are absent, not null.
  const legacy = { name: 'legacy', cpu_total: 16, cpu_used: 4, ram_total_mb: 65_536, ram_used_mb: 0 };
  assert.equal(measurementFresh(legacy, NOW), false);
  assert.equal(loadScore(legacy, NOW), 25);
  assert.equal(rankHosts([legacy], 1, 1024, NOW).length, 1);
});
