import { query } from '../db.js';
import { SchedulerLock, lockedTick } from '../lib/advisoryLock.js';
import { teamsUnderPressure } from '../lib/capacityPressure.js';
import { sendCapacityLimitEmail } from '../lib/email.js';
import { getPlan, nextTierUp } from '../plans.js';
import type { PlanTier } from '../config.js';

/** Window the notice reasons about. Two weeks smooths over the fact that CI
 *  load is weekly-shaped — a Monday-heavy team looks permanently saturated on a
 *  3-day window and completely idle on a weekend one. */
const WINDOW_DAYS = 14;

/** How many waiting runs make this worth an email. One or two is a busy
 *  afternoon, not a capacity problem; five separate runs across two weeks is a
 *  pattern the owner would want to know about. */
const MIN_BLOCKED_RUNS = 5;

/** Deliberately long. This mail is unsolicited and its subject is "give us more
 *  money", so the cost of sending it too often is much higher than the cost of
 *  sending it late — a team that genuinely lives at its limit will still be
 *  over the threshold next month. */
const COOLDOWN_DAYS = 30;

function humanWait(seconds: number): string | null {
  if (seconds < 60) return null; // below a minute isn't worth claiming
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 6) / 10; // one decimal
  return `${hours} hours`;
}

/**
 * Mails team owners whose runs keep queueing behind their own parallelism cap.
 *
 * Parallelism is the whole pricing model, so a team sitting at its limit is the
 * clearest upgrade signal the system produces — and until the scheduler started
 * stamping capacity_blocked_at (migration 033), it was visible to nobody. The
 * customer saw slow pipelines with no stated cause; we saw nothing at all.
 */
export async function sendCapacityNotices(): Promise<void> {
  const candidates = await teamsUnderPressure(WINDOW_DAYS, MIN_BLOCKED_RUNS, COOLDOWN_DAYS);

  for (const team of candidates) {
    const plan = getPlan(team.planTier as PlanTier);
    // A lapsed free trial can't reach the threshold (reserveSlot skips the
    // stamp at parallelEnvs === 0), but guard anyway: a 0-limit team offered an
    // upgrade path would be getting the wrong mail entirely.
    if (plan.parallelEnvs <= 0) continue;
    const upgrade = nextTierUp(plan.tier);

    try {
      await sendCapacityLimitEmail(team.email, {
        teamName: team.teamName,
        blockedRuns: team.blockedRuns,
        windowDays: WINDOW_DAYS,
        waitText: humanWait(team.waitSecondsTotal),
        currentLimit: plan.parallelEnvs,
        upgradeLabel: upgrade?.label ?? null,
        upgradeParallel: upgrade?.parallelEnvs ?? null,
        upgradeChf: upgrade?.chfMonthly ?? null,
      });
      // Stamped only after a successful send, so a Resend outage retries on the
      // next sweep rather than silently swallowing the notice for 30 days.
      await query('UPDATE teams SET capacity_notice_sent_at = now() WHERE id = $1', [team.teamId]);
    } catch (err) {
      console.error(`[capacity-notices] could not notify team ${team.teamId}`, err);
    }
  }
}

/** Daily. The window is two weeks and the cooldown a month, so a faster tick
 *  would only re-run the same query to find the same nothing. */
export function startCapacityNoticeWorker(intervalMs = 24 * 3_600_000): () => void {
  // Advisory-locked for the same reason as the trial sweep: the cooldown is
  // recorded after the send, so two instances sweeping together would both see
  // the team as un-notified and mail the owner twice.
  const tick = lockedTick('capacity-notices', SchedulerLock.capacityNotices, sendCapacityNotices);
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
