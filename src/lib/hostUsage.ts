/**
 * Reading the measured-usage columns from `hosts` (migration 035).
 *
 * Shared rather than inlined at each call site because "is this measurement
 * usable" is a rule, not a formatting detail, and it has to be answered the
 * same way by the admin dashboard today and by placement later. A host that
 * looks unmeasured in one place and idle-with-lots-of-room in another would
 * produce exactly the scheduling mistake this whole effort exists to avoid.
 */

/**
 * Measurements older than this are treated as absent.
 *
 * Agents heartbeat every ~20s and the scheduler polls health every ~5s, so two
 * minutes is six consecutive misses — comfortably past a transient blip, well
 * short of the point where numbers describe a host that has since changed. The
 * failure this guards is specific: an agent that stops reporting leaves its
 * last values sitting in the row, and without a staleness rule they read as
 * current forever.
 */
export const USAGE_STALE_AFTER_MS = 120_000;

/** The raw columns, as they come back from Postgres. `cpu_used_actual` is
 *  numeric, which node-postgres hands over as a string to avoid silently
 *  losing precision — hence the explicit conversion below. */
export interface HostUsageColumns {
  ram_committed_mb: number | null;
  ram_granted_mb: number | null;
  ram_guest_used_mb: number | null;
  ram_host_available_mb: number | null;
  cpu_busy_pct: number | null;
  cpu_used_actual: string | number | null;
  cpu_throttled_vms: number | null;
  usage_reported_at: string | Date | null;
}

export interface HostUsage {
  ramCommittedMb: number | null;
  ramGrantedMb: number | null;
  ramGuestUsedMb: number | null;
  ramHostAvailableMb: number | null;
  /** What the balloons are currently holding back — the saving, made explicit
   *  rather than left for the reader to subtract. */
  ramReclaimedMb: number | null;
  cpuBusyPct: number | null;
  cpuUsedActual: number | null;
  cpuThrottledVms: number | null;
  measuredAt: string | null;
  /** True when measurements exist but are too old to act on. Distinct from
   *  `null` usage, which means the host never reported at all — the UI says
   *  different things about a host that lost its agent and one that runs an
   *  older build. */
  stale: boolean;
}

function toNumber(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Shapes the usage columns for an API response, or returns null when the host
 *  has never reported any of them. */
export function presentHostUsage(row: HostUsageColumns, now = Date.now()): HostUsage | null {
  if (!row.usage_reported_at) return null;
  const measuredAt = row.usage_reported_at instanceof Date
    ? row.usage_reported_at
    : new Date(row.usage_reported_at);
  const committed = toNumber(row.ram_committed_mb);
  const granted = toNumber(row.ram_granted_mb);
  return {
    ramCommittedMb: committed,
    ramGrantedMb: granted,
    ramGuestUsedMb: toNumber(row.ram_guest_used_mb),
    ramHostAvailableMb: toNumber(row.ram_host_available_mb),
    ramReclaimedMb: committed !== null && granted !== null ? Math.max(0, committed - granted) : null,
    cpuBusyPct: toNumber(row.cpu_busy_pct),
    cpuUsedActual: toNumber(row.cpu_used_actual),
    cpuThrottledVms: toNumber(row.cpu_throttled_vms),
    measuredAt: measuredAt.toISOString(),
    stale: now - measuredAt.getTime() > USAGE_STALE_AFTER_MS,
  };
}

/** The columns every reader of host usage needs, so the list doesn't drift
 *  between queries. */
export const HOST_USAGE_COLUMNS = `ram_committed_mb, ram_granted_mb, ram_guest_used_mb,
  ram_host_available_mb, cpu_busy_pct, cpu_used_actual, cpu_throttled_vms, usage_reported_at`;
