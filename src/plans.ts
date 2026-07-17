import { query } from './db.js';
import type { PlanTier } from './config.js';

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
}

const TIER_ORDER: PlanTier[] = ['free', 'solo', 'team', 'scale'];

let cache: Record<PlanTier, Plan> | null = null;

export async function loadPlans(): Promise<void> {
  const res = await query<{
    id: PlanTier; name: string; price_chf_monthly: number;
    max_parallel_environments: number; vcpu_per_environment: number;
    ram_gb_per_environment: number; trial_duration_days: number | null;
  }>(
    `SELECT id, name, price_chf_monthly, max_parallel_environments,
            vcpu_per_environment, ram_gb_per_environment, trial_duration_days
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

/** Max total RAM a tier can occupy at once, in GB (derived, never stored). */
export function maxFootprintGb(plan: Plan): number {
  return Math.round((plan.parallelEnvs * plan.ramMbPerEnv) / 1024);
}
