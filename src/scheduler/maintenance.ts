import { config } from '../config.js';
import { maybeOne, query } from '../db.js';
import { SchedulerLock, lockedTick } from '../lib/advisoryLock.js';
import { sendOpsAlert } from '../lib/alerts.js';

/**
 * Prunes rows that exist only to answer a question about the recent past.
 *
 * Several tables here are append-only by design and had nothing deleting from
 * them: every sign-in adds a `user_sessions` row, every signup and password
 * reset adds a `verification_tokens` row, every Stripe delivery adds a
 * `stripe_events` row. None of it is queried beyond a short window, so it was
 * pure accumulation — slower sequential scans and a backup that grows for no
 * reason.
 *
 * Each cutoff is deliberately well past the window the data is actually read
 * over, so pruning can never delete something still in use.
 */
export async function runMaintenance(): Promise<void> {
  // Session JWTs live 7 days; the inventory endpoint only lists sessions from
  // the last 7 days for that reason. 30 days leaves a wide margin while still
  // bounding the table.
  const sessions = await query(
    `DELETE FROM user_sessions
     WHERE created_at < now() - interval '30 days'`,
  );

  // A verification/reset token is dead once it expires — issuing a new one
  // already deletes the user's previous tokens of that type, so what's left
  // here belongs to people who simply never came back.
  const tokens = await query(
    `DELETE FROM verification_tokens
     WHERE expires_at < now() - interval '7 days'`,
  );

  // Only needed while Stripe might still retry a delivery, which it gives up
  // on well inside three days.
  const events = await query(
    `DELETE FROM stripe_events
     WHERE processed_at < now() - interval '7 days'`,
  );

  const total = (sessions.rowCount ?? 0) + (tokens.rowCount ?? 0) + (events.rowCount ?? 0);
  if (total > 0) {
    console.log(
      `[maintenance] pruned ${sessions.rowCount} sessions, ${tokens.rowCount} verification tokens, ${events.rowCount} stripe events`,
    );
  }
}

/** How long backups may go unreported before it counts as an outage. Nightly
 *  is the schedule, so 48h tolerates one missed night (a slow run, a reboot)
 *  without crying wolf, while still catching a genuinely stopped job fast. */
const BACKUP_STALE_HOURS = 48;

/**
 * Alerts when the backup script stops reporting.
 *
 * This is the half of a backup system people forget to build. A job that fails
 * loudly gets fixed; a job that quietly stopped running four months ago looks
 * exactly like a working one from the outside, and you find out on the single
 * day it matters. backup.sh reports every run, so silence is itself the signal.
 *
 * Alerts once per outage — `platform_settings.backup_alerted_at` is set when
 * we warn and cleared by the next successful report, so a broken backup mails
 * ops once, not daily forever.
 */
export async function checkBackupFreshness(): Promise<void> {
  // Reporting is opt-in via the shared token. Without it there's nothing to be
  // silent about, and alerting would just be noise on a deployment that has
  // deliberately not set this up.
  if (!config.backupReportToken) return;

  const state = await maybeOne<{ last_ok: string | null; alerted_at: string | null }>(
    `SELECT (SELECT max(created_at) FROM backup_runs WHERE status IN ('ok', 'verified')) AS last_ok,
            (SELECT backup_alerted_at FROM platform_settings WHERE id = 1) AS alerted_at`,
  );
  if (!state) return;

  const lastOk = state.last_ok ? new Date(state.last_ok) : null;
  const staleAfter = Date.now() - BACKUP_STALE_HOURS * 3_600_000;
  const stale = !lastOk || lastOk.getTime() < staleAfter;
  if (!stale || state.alerted_at) return;

  // Claim the alert before sending, so two instances racing here can't both
  // mail. (The advisory lock already serialises the sweep; this also covers a
  // manual invocation.)
  const claimed = await query(
    'UPDATE platform_settings SET backup_alerted_at = now() WHERE id = 1 AND backup_alerted_at IS NULL',
  );
  if (claimed.rowCount !== 1) return;

  const since = lastOk ? `The last successful backup was ${lastOk.toISOString()}.` : 'No successful backup has ever been reported.';
  await sendOpsAlert(
    'No database backup in ' + BACKUP_STALE_HOURS + ' hours',
    `${since}\n\nThe nightly job on the VPS has stopped reporting. Check the cron entry and `
    + '/var/log/devplat-backup.log, then run deploy/backup/backup.sh by hand to confirm it works again.\n\n'
    + 'Until then there is no recent copy of the database anywhere but the VPS itself.',
    ':rotating_light:',
  ).catch((err: unknown) => console.error('[maintenance] backup staleness alert failed', err));
}

/** Daily is plenty — nothing here is urgent, and the cutoffs are in days. */
export function startMaintenanceWorker(intervalMs = 24 * 3_600_000): () => void {
  const tick = lockedTick('maintenance', SchedulerLock.maintenance, async () => {
    await runMaintenance();
    await checkBackupFreshness();
  });
  tick(); // once at startup, so a long-lived backlog gets cleared on deploy
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
