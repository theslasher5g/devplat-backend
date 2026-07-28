import { query } from '../db.js';
import { sendOpsAlert } from './alerts.js';
import { fingerprint as fingerprintFor, redact } from './errorFingerprint.js';

/**
 * Self-hosted error tracking.
 *
 * Errors previously went to console.error and into the container log, so the
 * first signal that something was broken was a customer writing in. This
 * groups them by fingerprint, counts occurrences, and alerts once when a new
 * one appears.
 *
 * Deliberately not Sentry: that would be another sub-processor to name in the
 * privacy policy and another place customer data could land, for a product
 * whose whole pitch is that it runs on our own hardware in Basel. The
 * expensive parts of a hosted tracker — grouping, dedupe, alerting — are the
 * few dozen lines below.
 */

/** How long an already-alerted fingerprint stays quiet before it alerts again.
 *  Long enough that a crash loop mails once; short enough that a problem which
 *  is still happening tomorrow says so. */
const REALERT_AFTER_MS = 6 * 3_600_000;

export interface CapturedError {
  source: 'api' | 'client';
  message: string;
  stack?: string;
  /** Route pattern, not the concrete URL. */
  route?: string;
  method?: string;
  statusCode?: number;
}

/**
 * Records one error occurrence and alerts if it's new (or has been quiet).
 *
 * Never throws: this is called from the error handler, and a failure to record
 * an error must not become a second error. Returns nothing the caller needs.
 */
export async function captureError(e: CapturedError): Promise<void> {
  try {
    const message = redact(e.message).slice(0, 2000);
    const stack = e.stack ? redact(e.stack).slice(0, 4000) : null;
    const fingerprint = fingerprintFor({ source: e.source, message, stack: e.stack, route: e.route });

    // One statement does insert-or-bump and tells us whether this is new and
    // whether it's due an alert, so there's no read-then-write race between
    // two requests failing at the same instant.
    const row = await query<{ count: number; is_new: boolean; should_alert: boolean }>(
      // alerted_at is set on the initial INSERT too, not only in the conflict
      // branch — a brand-new error is precisely the one worth hearing about,
      // and leaving it NULL here meant the first occurrence stayed silent and
      // the second reported itself as "recurring".
      `INSERT INTO error_events (fingerprint, source, message, stack, route, method, status_code, alerted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (fingerprint) DO UPDATE SET
         count = error_events.count + 1,
         last_seen_at = now(),
         -- A recurrence re-opens something previously marked resolved: if it's
         -- back, it wasn't fixed.
         resolved_at = NULL,
         message = EXCLUDED.message,
         stack = COALESCE(EXCLUDED.stack, error_events.stack),
         alerted_at = CASE
           WHEN error_events.alerted_at IS NULL
             OR error_events.alerted_at < now() - ($8 || ' milliseconds')::interval
           THEN now() ELSE error_events.alerted_at END
       RETURNING count,
                 (count = 1) AS is_new,
                 (alerted_at >= now() - interval '5 seconds') AS should_alert`,
      [fingerprint, e.source, message, stack, e.route ?? null, e.method ?? null,
        e.statusCode ?? null, String(REALERT_AFTER_MS)],
    );

    const result = row.rows[0];
    if (!result?.should_alert) return;

    const where = e.route ? `${e.method ?? ''} ${e.route}`.trim() : e.source;
    await sendOpsAlert(
      `${result.is_new ? 'New' : 'Recurring'} ${e.source} error — ${where}`,
      `${message}\n\n${stack ?? '(no stack)'}\n\nSeen ${result.count}× in total. `
      + 'Full list in the admin dashboard under Errors.',
      result.is_new ? ':bug:' : ':repeat:',
    );
  } catch (err) {
    // Last resort. If tracking itself is broken, say so once and move on —
    // the original error has already been logged by the caller.
    console.error('[errors] could not record error', err);
  }
}
