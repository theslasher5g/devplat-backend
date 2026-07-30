/**
 * Choosing which host a new environment lands on.
 *
 * Split out of allocator.ts and kept free of the database so the ordering rule
 * can be tested exhaustively — the cases that matter are combinations of
 * measured, unmeasured and stale hosts, and none of them need Postgres to
 * express.
 *
 * The problem being solved: placement used to sort purely on *reserved* free
 * CPU — capacity minus the sum of what running VMs' plans entitle them to. On a
 * platform whose entire economics rest on plans being ceilings that are almost
 * never reached, that is the wrong number. A host running eight VMs idling at
 * 3% looked exactly as full as one under sustained load, so new work kept being
 * spread by paperwork rather than by what the machines were actually doing.
 */

import { USAGE_STALE_AFTER_MS } from '../lib/hostUsage.js';

/** What ranking needs from a host row. */
export interface PlacementHost {
  name: string;
  cpu_total: number;
  cpu_used: number;
  ram_total_mb: number;
  ram_used_mb: number;
  /** Measured host-wide CPU utilisation, 0–100. Null or absent when never
   *  reported — an older agent build has no column value at all. */
  cpu_busy_pct?: number | null;
  /** Measured memory the host still has, from its own /proc/meminfo. */
  ram_host_available_mb?: number | null;
  usage_reported_at?: string | Date | null;
}

/** Reserved (contractual) room. This is what the agent admits against, so it
 *  stays the filter — measurement informs preference, never entitlement. */
export function reservedFreeCpu(h: PlacementHost): number { return h.cpu_total - h.cpu_used; }
export function reservedFreeRamMb(h: PlacementHost): number { return h.ram_total_mb - h.ram_used_mb; }

export function fits(h: PlacementHost, vcpu: number, ramMb: number): boolean {
  return reservedFreeCpu(h) >= vcpu && reservedFreeRamMb(h) >= ramMb;
}

/** Whether this host's measurements are recent enough to place on. */
export function measurementFresh(h: PlacementHost, now = Date.now()): boolean {
  if (h.cpu_busy_pct === null || h.cpu_busy_pct === undefined) return false;
  if (h.usage_reported_at === null || h.usage_reported_at === undefined) return false;
  const at = h.usage_reported_at instanceof Date
    ? h.usage_reported_at.getTime()
    : new Date(h.usage_reported_at).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at <= USAGE_STALE_AFTER_MS;
}

/**
 * How loaded a host is, 0–100, lower being emptier.
 *
 * The single most important decision in this file is what an *unmeasured* host
 * scores. Zero would be catastrophic: every host running an older agent build,
 * and every host whose agent just died, would look completely idle and attract
 * all new work — the same trap the nullable columns in migration 035 were
 * shaped to avoid. A hundred is the opposite mistake: it strands hosts that are
 * perfectly healthy and merely quiet about it.
 *
 * So an unmeasured host is scored by its reservations, which is exactly how
 * every host was scored before measurement existed. That puts both kinds on one
 * comparable scale, keeps the old behaviour as the floor, and means the only
 * thing measurement can do is move a host relative to where it already sat.
 *
 * A stale measurement is treated as no measurement, not as the last known good
 * value: an agent that stopped reporting leaves its final numbers in the row,
 * and those describe a host that may have been filling up ever since.
 */
export function loadScore(h: PlacementHost, now = Date.now()): number {
  if (measurementFresh(h, now)) return clamp(h.cpu_busy_pct as number);
  if (h.cpu_total <= 0) return 100;
  return clamp((h.cpu_used / h.cpu_total) * 100);
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

/**
 * Hosts that can take a VM of this size, emptiest first.
 *
 * Ordering, in priority order:
 *
 *  1. Load score ascending — the least-loaded machine by whatever evidence
 *     exists for it. Bucketed to 5-point steps rather than compared exactly, so
 *     a host at 41% and one at 43% are considered equal and the tiebreakers
 *     below decide. Without the bucket, momentary CPU noise would reshuffle the
 *     order between two consecutive placements and pile work onto whichever
 *     host happened to dip during the sample.
 *  2. Reserved free CPU descending — among equally-loaded hosts, the one with
 *     the most contractual room, which keeps the fleet's committed capacity
 *     spread rather than concentrated.
 *  3. Name — so the order is stable and a test can assert it.
 */
export function rankHosts<T extends PlacementHost>(
  hosts: T[], vcpu: number, ramMb: number, now = Date.now(),
): T[] {
  const LOAD_BUCKET = 5;
  return hosts
    .filter((h) => fits(h, vcpu, ramMb))
    .map((h) => ({ h, bucket: Math.floor(loadScore(h, now) / LOAD_BUCKET) }))
    .sort((a, b) =>
      a.bucket - b.bucket
      || reservedFreeCpu(b.h) - reservedFreeCpu(a.h)
      || a.h.name.localeCompare(b.h.name))
    .map((x) => x.h);
}
