import { query } from '../db.js';
import { SchedulerLock, lockedTick } from '../lib/advisoryLock.js';

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

/** Daily is plenty — nothing here is urgent, and the cutoffs are in days. */
export function startMaintenanceWorker(intervalMs = 24 * 3_600_000): () => void {
  const tick = lockedTick('maintenance', SchedulerLock.maintenance, runMaintenance);
  tick(); // once at startup, so a long-lived backlog gets cleared on deploy
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
