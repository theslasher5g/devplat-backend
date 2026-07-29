import { one, query } from '../db.js';
import { type Plan, getPlan, nextTierUp } from '../plans.js';

/**
 * How often a team's runs had to wait because their plan's parallelism cap was
 * full — the signal behind both the dashboard's usage card and the owner notice
 * in scheduler/capacityNotices.ts.
 *
 * Note on what "budget warning" means for this product: billing is flat per
 * parallel environment with no per-minute metering, so there is no spend that
 * can run away and nothing to cap. The equivalent — and the thing that actually
 * costs the customer money, in engineer-minutes spent watching CI — is paying
 * for N parallel environments while routinely needing more. That is what this
 * measures.
 */
export interface CapacityPressure {
  windowDays: number;
  /** Runs started in the window. */
  totalRuns: number;
  /** Of those, how many had to wait for a free slot at least once. */
  blockedRuns: number;
  /** Waits that ended in an assignment — the only ones with a known duration. */
  resolvedWaits: number;
  waitSecondsTotal: number;
  waitSecondsWorst: number;
  /** Runs queued for a slot right now. A live number, not part of the window. */
  waitingNow: number;
  limit: number;
  planTier: string;
  /** The tier that would relieve this, if there is one above the current. */
  upgrade: { tier: string; label: string; parallelEnvs: number; chfMonthly: number } | null;
}

/** Runs in the window that waited, and by how much. Durations are computed only
 *  where the wait demonstrably ended (assigned_at is set). A run that was
 *  blocked and then failed to boot has no end stamp, and COALESCE(..., now())
 *  would report its wait as growing forever — the same mistake the environment
 *  history endpoint used to make. Unknown stays unknown. */
export async function capacityPressure(teamId: string, windowDays = 14): Promise<CapacityPressure> {
  const stats = await one<{
    total_runs: string; blocked_runs: string; resolved_waits: string;
    wait_total: string | null; wait_worst: string | null; waiting_now: string;
  }>(
    `SELECT
       count(*)::text AS total_runs,
       count(*) FILTER (WHERE capacity_blocked_at IS NOT NULL)::text AS blocked_runs,
       count(*) FILTER (WHERE capacity_blocked_at IS NOT NULL AND assigned_at IS NOT NULL)::text AS resolved_waits,
       COALESCE(SUM(EXTRACT(EPOCH FROM (assigned_at - capacity_blocked_at)))
                FILTER (WHERE capacity_blocked_at IS NOT NULL AND assigned_at IS NOT NULL), 0)::text AS wait_total,
       COALESCE(MAX(EXTRACT(EPOCH FROM (assigned_at - capacity_blocked_at)))
                FILTER (WHERE capacity_blocked_at IS NOT NULL AND assigned_at IS NOT NULL), 0)::text AS wait_worst,
       count(*) FILTER (WHERE capacity_blocked_at IS NOT NULL AND status = 'queued')::text AS waiting_now
     FROM environment_requests
     WHERE team_id = $1 AND requested_at >= now() - ($2::int * interval '1 day')`,
    [teamId, windowDays],
  );

  const team = await one<{ plan_tier: string }>(
    'SELECT COALESCE(plan_override, plan_tier) AS plan_tier FROM teams WHERE id = $1',
    [teamId],
  );
  const plan = getPlan(team.plan_tier as Plan['tier']);
  const next = nextTierUp(plan.tier);

  return {
    windowDays,
    totalRuns: Number(stats.total_runs),
    blockedRuns: Number(stats.blocked_runs),
    resolvedWaits: Number(stats.resolved_waits),
    waitSecondsTotal: Math.round(Number(stats.wait_total ?? 0)),
    waitSecondsWorst: Math.round(Number(stats.wait_worst ?? 0)),
    waitingNow: Number(stats.waiting_now),
    limit: plan.parallelEnvs,
    planTier: plan.tier,
    upgrade: next
      ? { tier: next.tier, label: next.label, parallelEnvs: next.parallelEnvs, chfMonthly: next.chfMonthly }
      : null,
  };
}

/** Teams whose pressure over the window crosses the notice threshold and that
 *  are outside the cooldown. Deliberately one query: the sweep runs hourly over
 *  every team, and doing this per team would be a full table scan of requests
 *  per row. */
export interface PressureCandidate {
  teamId: string; teamName: string; email: string; planTier: string;
  blockedRuns: number; waitSecondsTotal: number;
}

export async function teamsUnderPressure(
  windowDays: number, minBlockedRuns: number, cooldownDays: number,
): Promise<PressureCandidate[]> {
  const res = await query<{
    team_id: string; team_name: string; email: string; plan_tier: string;
    blocked_runs: string; wait_total: string;
  }>(
    `SELECT t.id AS team_id, t.name AS team_name, u.email,
            COALESCE(t.plan_override, t.plan_tier) AS plan_tier,
            p.blocked_runs::text, p.wait_total::text
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id AND tm.role = 'owner'
     JOIN users u ON u.id = tm.user_id
     JOIN LATERAL (
       SELECT count(*) FILTER (WHERE er.capacity_blocked_at IS NOT NULL) AS blocked_runs,
              COALESCE(SUM(EXTRACT(EPOCH FROM (er.assigned_at - er.capacity_blocked_at)))
                       FILTER (WHERE er.capacity_blocked_at IS NOT NULL AND er.assigned_at IS NOT NULL), 0) AS wait_total
       FROM environment_requests er
       WHERE er.team_id = t.id AND er.requested_at >= now() - ($1::int * interval '1 day')
     ) p ON true
     WHERE u.email_verified_at IS NOT NULL
       AND p.blocked_runs >= $2
       AND (t.capacity_notice_sent_at IS NULL OR t.capacity_notice_sent_at < now() - ($3::int * interval '1 day'))`,
    [windowDays, minBlockedRuns, cooldownDays],
  );
  return res.rows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    email: r.email,
    planTier: r.plan_tier,
    blockedRuns: Number(r.blocked_runs),
    waitSecondsTotal: Math.round(Number(r.wait_total)),
  }));
}
