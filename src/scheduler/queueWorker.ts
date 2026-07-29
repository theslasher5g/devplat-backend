import { type PlanTier } from '../config.js';
import { query } from '../db.js';
import { SchedulerLock, lockedTick } from '../lib/advisoryLock.js';
import { getPlan } from '../plans.js';
import { reclaimStaleAssignments, tryAssign } from './allocator.js';

/** Periodically retries queued environment requests as capacity frees up
 *  (a released VM, a host coming back online, or new capacity registered).
 *  Bounded batch per tick so one noisy team can't starve others. */
export async function processQueue(): Promise<void> {
  await reclaimStaleAssignments();

  const queued = await query<{ id: string; team_id: string; plan_tier: PlanTier; trial_ends_at: string }>(
    `SELECT er.id, er.team_id, COALESCE(t.plan_override, t.plan_tier) AS plan_tier, t.trial_ends_at
     FROM environment_requests er JOIN teams t ON t.id = er.team_id
     WHERE er.status = 'queued'
     ORDER BY er.requested_at ASC
     LIMIT 20`,
  );
  if (queued.rowCount === 0) return;

  // No per-team bookkeeping here any more. tryAssign reserves the slot under a
  // per-team advisory lock (see allocator.reserveSlot), which is the only
  // count that can be trusted — this worker runs concurrently with the API's
  // own POST /environments handler, so a tally held in this process was a
  // second, unsynchronised source of truth. It simply asks, and skips the row
  // when there's no room.
  for (const r of queued.rows) {
    const plan = getPlan(r.plan_tier);
    const trialExpired = r.plan_tier === 'free' && new Date(r.trial_ends_at) < new Date();
    await tryAssign(r.id, r.team_id, {
      parallelEnvs: trialExpired ? 0 : plan.parallelEnvs,
      vcpu: plan.vcpuPerEnv,
      ramMb: plan.ramMbPerEnv,
    });
  }
}

export function startQueueWorker(intervalMs: number): () => void {
  // Advisory-locked: two instances assigning from the same queue would each
  // read a team's running count before the other's assignment landed, letting
  // a team exceed its parallel-environment limit. See lib/advisoryLock.ts.
  const timer = setInterval(lockedTick('queue worker', SchedulerLock.queueWorker, processQueue), intervalMs);
  return () => clearInterval(timer);
}
