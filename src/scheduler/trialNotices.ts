import { query } from '../db.js';
import { sendTrialEndingEmail } from '../lib/email.js';

/**
 * Warn team owners before their free trial lapses, and once when it has.
 *
 * Without this the first sign that a trial ended is a CI pipeline failing:
 * effectivePlan() drops an expired free team to zero parallel environments,
 * and nothing had ever told the owner that was coming.
 *
 * Milestones are days-remaining thresholds. A team is mailed at most once per
 * milestone (teams.trial_notice_sent_at_days records the lowest one already
 * sent), so a daily sweep is idempotent.
 */
const MILESTONES = [3, 0] as const;

export async function sendTrialNotices(): Promise<void> {
  for (const milestone of MILESTONES) {
    const due = await query<{ id: string; name: string; email: string; days_left: number }>(
      `SELECT t.id, t.name, u.email,
              CEIL(EXTRACT(EPOCH FROM (t.trial_ends_at - now())) / 86400)::int AS days_left
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id AND tm.role = 'owner'
       JOIN users u ON u.id = tm.user_id
       WHERE t.plan_tier = 'free'
         AND u.email_verified_at IS NOT NULL
         AND CEIL(EXTRACT(EPOCH FROM (t.trial_ends_at - now())) / 86400)::int <= $1
         -- Not yet notified at this milestone (NULL = never notified at all).
         AND (t.trial_notice_sent_at_days IS NULL OR t.trial_notice_sent_at_days > $1)`,
      [milestone],
    );

    for (const team of due.rows) {
      try {
        await sendTrialEndingEmail(team.email, { teamName: team.name, daysLeft: Math.max(team.days_left, 0) });
        // Record the milestone only after the send succeeded, so a transient
        // mail failure is retried on the next sweep instead of being lost.
        await query('UPDATE teams SET trial_notice_sent_at_days = $1 WHERE id = $2', [milestone, team.id]);
      } catch (err) {
        console.error(`[trial-notices] could not notify team ${team.id}`, err);
      }
    }
  }
}

/** Runs the sweep on an interval. Hourly is plenty for a daily-granularity
 *  notice and keeps the query cost negligible. */
export function startTrialNoticeWorker(intervalMs = 3_600_000): () => void {
  const tick = () => {
    sendTrialNotices().catch((err) => console.error('[trial-notices] sweep failed', err));
  };
  tick(); // once at startup so a restart doesn't delay overdue notices
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
