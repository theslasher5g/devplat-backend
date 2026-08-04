import { query } from './db.js';
import type { PlanTier } from './config.js';
// The arithmetic lives in lib/pricing.ts, which has no database import — see
// the note there. Re-exported so callers keep a single place to reach for.
export { billableSeats, monthlyCost } from './lib/pricing.js';
import { nextAvailable } from './lib/pricing.js';

/**
 * Plan/tier data. The `plans` table (migrations/003_plans.sql) is the single
 * source of truth; this module loads it once at startup into a typed cache so
 * the many read sites (billing, teams, admin, scheduler) stay cheap and
 * synchronous. Tier data changes rarely (a price or cap edit is a deliberate
 * act), so a restart to pick up a SQL change is acceptable — the alternative,
 * a DB round-trip on every request, buys nothing here.
 */
export interface Plan {
  tier: PlanTier;
  label: string;
  chfMonthly: number;
  parallelEnvs: number;
  vcpuPerEnv: number;
  ramMbPerEnv: number;
  /** Only Free Trial is time-boxed; null for paid tiers. */
  trialDurationDays: number | null;
  /** Seat cap for the team; null means unlimited (top tier). */
  maxMembers: number | null;
  /** Added to the bill for each seat beyond `includedSeats`. Zero on tiers that
   *  do not charge per seat. */
  chfPerSeatMonthly: number;
  /** Seats covered by the base price. The base and the per-seat price would
   *  otherwise double-charge the first users. */
  includedSeats: number;
  /** Whether this tier can still be bought. A retired tier stays resolvable —
   *  teams and historical subscriptions still reference it — but is not
   *  offered. */
  available: boolean;
  /** Whether a customer can buy it themselves. False means "contact us": the
   *  pricing page shows no price and checkout refuses. */
  selfServe: boolean;
  /** Environment TTL this tier gets by default, in minutes. */
  ttlDefaultMinutes: number;
  /** Highest TTL this tier may be raised to. Equal to the default on tiers
   *  where the TTL is fixed, which is how "not configurable" is expressed. */
  ttlMaxMinutes: number;
  /** Whether this tier may READ its audit log. Records are written on every
   *  tier regardless — see migration 037 for why. */
  auditLog: boolean;
}

const TIER_ORDER: PlanTier[] = ['free', 'solo', 'team', 'scale'];

let cache: Record<PlanTier, Plan> | null = null;

export async function loadPlans(): Promise<void> {
  const res = await query<{
    id: PlanTier; name: string; price_chf_monthly: number;
    max_parallel_environments: number; vcpu_per_environment: number;
    ram_gb_per_environment: number; trial_duration_days: number | null;
    max_members: number | null;
    ttl_default_minutes: number; ttl_max_minutes: number;
    audit_log: boolean;
    price_chf_per_seat_monthly: string | number;
    included_seats: number;
    available: boolean;
    self_serve: boolean;
  }>(
    `SELECT id, name, price_chf_monthly, max_parallel_environments,
            vcpu_per_environment, ram_gb_per_environment, trial_duration_days,
            max_members, ttl_default_minutes, ttl_max_minutes, audit_log,
            price_chf_per_seat_monthly, included_seats, available, self_serve
     FROM plans`,
  );
  const map = {} as Record<PlanTier, Plan>;
  for (const r of res.rows) {
    map[r.id] = {
      tier: r.id,
      label: r.name,
      chfMonthly: Number(r.price_chf_monthly),
      parallelEnvs: r.max_parallel_environments,
      vcpuPerEnv: r.vcpu_per_environment,
      ramMbPerEnv: r.ram_gb_per_environment * 1024,
      trialDurationDays: r.trial_duration_days,
      maxMembers: r.max_members,
      ttlDefaultMinutes: r.ttl_default_minutes,
      ttlMaxMinutes: r.ttl_max_minutes,
      auditLog: r.audit_log,
      chfPerSeatMonthly: Number(r.price_chf_per_seat_monthly),
      includedSeats: r.included_seats,
      available: r.available,
      selfServe: r.self_serve,
    };
  }
  for (const tier of TIER_ORDER) {
    if (!map[tier]) throw new Error(`plans table is missing tier "${tier}" — run migrations`);
  }
  cache = map;
}

export function getPlan(tier: PlanTier): Plan {
  if (!cache) throw new Error('plans not loaded — call loadPlans() at startup');
  const plan = cache[tier];
  if (!plan) throw new Error(`unknown plan tier "${tier}"`);
  return plan;
}

export function allPlans(): Plan[] {
  return TIER_ORDER.map(getPlan);
}

/** The next tier up, or null at the top. Used to turn "you keep hitting your
 *  limit" into a concrete suggestion rather than a complaint.
 *
 *  Retired tiers are skipped, which is why this is a scan and not `i + 1`.
 *  Since Solo was retired (migration 043) the naive step would answer "Solo"
 *  for every evaluation team that hit its limit — a plan whose checkout refuses
 *  with 410. A suggestion nobody can act on is worse than none.
 *
 *  Sales-led tiers are NOT skipped: "talk to us" is a real next step, and it is
 *  the top of the range, so skipping it would leave large teams with nothing. */
export function nextTierUp(tier: PlanTier): Plan | null {
  const next = nextAvailable(TIER_ORDER, tier, (t) => getPlan(t).available);
  return next ? getPlan(next) : null;
}

/** Max total RAM a tier can occupy at once, in GB (derived, never stored). */
export function maxFootprintGb(plan: Plan): number {
  return Math.round((plan.parallelEnvs * plan.ramMbPerEnv) / 1024);
}

/** Tiers a customer can actually buy today, cheapest first. Retired tiers stay
 *  resolvable for the teams already on them but are never offered again. */
export function purchasablePlans(): Plan[] {
  return allPlans().filter((p) => p.available);
}
