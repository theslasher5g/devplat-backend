import { type PlanTier } from '../config.js';
import { query } from '../db.js';
import { getPlan } from '../plans.js';
import { reclaimStaleAssignments, tryAssign } from './allocator.js';

/** Periodically retries queued environment requests as capacity frees up
 *  (a released VM, a host coming back online, or new capacity registered).
 *  Bounded batch per tick so one noisy team can't starve others. */
export async function processQueue(): Promise<void> {
  await reclaimStaleAssignments();

  const queued = await query<{ id: string; team_id: string; plan_tier: PlanTier; trial_ends_at: string }>(
    `SELECT er.id, er.team_id, t.plan_tier, t.trial_ends_at
     FROM environment_requests er JOIN teams t ON t.id = er.team_id
     WHERE er.status = 'queued'
     ORDER BY er.requested_at ASC
     LIMIT 20`,
  );
  if (queued.rowCount === 0) return;

  // Recheck each team's running count once per tick rather than per row —
  // several queued rows for the same team shouldn't all pass a stale check.
  const runningByTeam = new Map<string, number>();
  for (const r of queued.rows) {
    if (!runningByTeam.has(r.team_id)) {
      const running = await query<{ count: string }>(
        "SELECT count(*) FROM environment_requests WHERE team_id = $1 AND status = 'assigned'",
        [r.team_id],
      );
      runningByTeam.set(r.team_id, Number(running.rows[0].count));
    }
  }

  for (const r of queued.rows) {
    const plan = getPlan(r.plan_tier);
    const trialExpired = r.plan_tier === 'free' && new Date(r.trial_ends_at) < new Date();
    const limit = trialExpired ? 0 : plan.parallelEnvs;
    const running = runningByTeam.get(r.team_id) ?? 0;
    if (running >= limit) continue;

    const result = await tryAssign(r.id, r.team_id, plan.vcpuPerEnv, plan.ramMbPerEnv);
    if (result?.status === 'assigned') {
      runningByTeam.set(r.team_id, running + 1);
    }
  }
}

export function startQueueWorker(intervalMs: number): () => void {
  const timer = setInterval(() => {
    processQueue().catch((err) => console.error('[scheduler] queue worker tick failed', err));
  }, intervalMs);
  return () => clearInterval(timer);
}
