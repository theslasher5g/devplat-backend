import { pool } from '../db.js';

/**
 * Postgres advisory locks for the background schedulers.
 *
 * The queue worker, health poller and trial-notice sweep all assume they are
 * the only thing running. That holds for a single process and stops holding
 * the moment the API runs more than one replica — or during a rolling deploy,
 * where old and new containers overlap for a few seconds. Concurrent ticks are
 * not merely wasteful:
 *
 *   - two queue workers can each read the same 'queued' row and both call
 *     tryAssign, double-counting a team's parallel-environment limit;
 *   - two trial sweeps can read the same team before either writes
 *     trial_notice_sent_at_days, and the owner gets the same warning twice;
 *   - two health pollers hammer every agent at twice the intended rate.
 *
 * `pg_try_advisory_lock` is the right primitive here: it needs no table, it is
 * non-blocking (a losing instance skips the tick rather than queueing up a
 * backlog of them), and the lock is released automatically when the connection
 * goes away — so an instance that is SIGKILLed does not wedge the scheduler.
 *
 * The lock is session-scoped, so it must be taken and released on one dedicated
 * connection. That also means an overlong tick can't overlap itself: the next
 * tick asks on a different connection and simply skips.
 */

/** Fixed first key, so devplat's locks can't collide with anything else that
 *  might one day use advisory locks on the same database. */
const LOCK_NAMESPACE = 1_684_957_000;

/** Second key, one per job. Values are permanent — changing one is equivalent
 *  to releasing the lock for every instance still running the old code. */
export const SchedulerLock = {
  queueWorker: 1,
  healthPoller: 2,
  trialNotices: 3,
  maintenance: 4,
  capacityNotices: 5,
  webhookDelivery: 6,
  seatSync: 7,
} as const;

export type SchedulerLockId = (typeof SchedulerLock)[keyof typeof SchedulerLock];

/**
 * Runs `fn` only if this process can take the lock; otherwise returns
 * `{ ran: false }` without waiting. Another instance is doing the work, which
 * is the desired outcome, not an error.
 */
export async function withAdvisoryLock<T>(
  lockId: SchedulerLockId,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_NAMESPACE, lockId],
    );
    locked = res.rows[0]?.locked === true;
    if (!locked) return { ran: false };
    return { ran: true, value: await fn() };
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, lockId]);
        client.release();
      } catch (err) {
        // The unlock failed, so this connection may still be holding a
        // session-level lock. Returning it to the pool would hand that lock to
        // an unrelated caller and deadlock the job forever; destroy it instead
        // and let Postgres drop the lock with the session.
        console.error('[scheduler] advisory unlock failed, discarding connection', err);
        client.release(true);
      }
    } else {
      client.release();
    }
  }
}

/**
 * Wraps a scheduler tick so it is skipped when another instance holds the lock,
 * and so a thrown error is logged rather than becoming an unhandled rejection
 * that kills the process.
 */
export function lockedTick(name: string, lockId: SchedulerLockId, fn: () => Promise<unknown>): () => void {
  return () => {
    withAdvisoryLock(lockId, fn).catch((err) => console.error(`[scheduler] ${name} tick failed`, err));
  };
}
