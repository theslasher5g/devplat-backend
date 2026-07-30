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

  // Resolved errors that haven't recurred in three months are history, not
  // signal. Unresolved ones are never pruned — an error nobody looked at is
  // exactly the one worth keeping.
  const errors = await query(
    `DELETE FROM error_events
     WHERE resolved_at IS NOT NULL AND last_seen_at < now() - interval '90 days'`,
  );

  // A delivered webhook is read from exactly one place — the delivery log in
  // Settings, which shows the newest 100 and renders 20. It carries the full
  // event payload as jsonb, and one row is written per event per endpoint, so
  // this is the fastest-growing table in the schema and the one nothing was
  // deleting from.
  //
  // Failed deliveries get three months rather than one: they are the rows
  // someone actually comes back to ("why did our Slack hook stop in March"),
  // and a permanently failed endpoint is disabled after 10 attempts inside
  // about a day and a half, so nothing still being retried is ever in scope.
  const webhooks = await query(
    `DELETE FROM webhook_deliveries
     WHERE (status = 'delivered' AND created_at < now() - interval '30 days')
        OR (status = 'failed'    AND created_at < now() - interval '90 days')`,
  );

  // Metering data. The privacy policy commits to this in writing — "Usage/
  // metering records are kept for 24 months for billing accuracy and capacity
  // planning, then deleted" — and nothing was deleting them, so the promise was
  // being broken by omission rather than by choice. The widest window any
  // endpoint can ask for is 90 days (environments.ts clamps `days` to 90), so
  // 24 months is eight times past anything readable.
  const usage = await query(
    `DELETE FROM usage_events WHERE occurred_at < now() - interval '24 months'`,
  );

  // The run history behind that metering. Only terminal rows: a queued or
  // assigned row is a live environment, and COALESCE picks the moment the row
  // stopped changing, so a long-running environment is aged from its release
  // and not from its request.
  //
  // The `requested_at` term is redundant against the COALESCE — released_at is
  // never earlier than requested_at, so anything the COALESCE matches this also
  // matches — but it is what lets the planner use the index instead of reading
  // the whole table to find the handful of rows that aged out today.
  const runs = await query(
    `DELETE FROM environment_requests
     WHERE status IN ('released', 'failed')
       AND requested_at < now() - interval '24 months'
       AND COALESCE(released_at, requested_at) < now() - interval '24 months'`,
  );

  // Deliberately absent: audit_log. The privacy policy keeps account and team
  // data "while your account is active", Scale sells the trail as a feature,
  // and it is what a customer hands an auditor — a silent cutoff would delete
  // the evidence someone is paying to still have. It goes when the team goes,
  // via ON DELETE CASCADE, and not before.

  const total = (sessions.rowCount ?? 0) + (tokens.rowCount ?? 0) + (events.rowCount ?? 0)
    + (errors.rowCount ?? 0) + (webhooks.rowCount ?? 0) + (usage.rowCount ?? 0) + (runs.rowCount ?? 0);
  if (total > 0) {
    console.log(
      `[maintenance] pruned ${sessions.rowCount} sessions, ${tokens.rowCount} verification tokens, `
      + `${events.rowCount} stripe events, ${errors.rowCount} resolved errors, `
      + `${webhooks.rowCount} webhook deliveries, ${usage.rowCount} usage events, ${runs.rowCount} run records`,
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
