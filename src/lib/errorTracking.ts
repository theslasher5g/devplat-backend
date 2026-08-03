import { query } from '../db.js';
import { sendOpsAlert } from './alerts.js';
import { sanitizeRoute } from './sanitize.js';
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

/**
 * How many times a *client* error must be seen before it is worth an email.
 *
 * Server errors are ours: bounded in number, always our fault, and each new one
 * is worth hearing about immediately. Browser errors are not. They come from
 * machines we don't control — extensions, ad blockers, dying network
 * connections, a tab that was hung when the user closed the laptop — and their
 * volume scales with how many customers we have, which is exactly the wrong
 * quantity to attach an inbox to. A single hung browser produced a "Seen 1× in
 * total" alert; a thousand customers would have produced a thousand of them,
 * and the useful ones would have been buried in the noise they created.
 *
 * A threshold keeps the signal that actually matters. One user's bad afternoon
 * never reaches 25; a broken deploy hitting every session passes it within
 * minutes, and that is the case worth waking up for. Everything below the
 * threshold is still recorded and still visible in the admin dashboard under
 * Errors — nothing is lost, it just doesn't ring.
 */
const CLIENT_ALERT_MIN_COUNT = 25;

/**
 * Ceiling on error alert emails per hour, across all fingerprints.
 *
 * The per-fingerprint cooldown above stops one error from mailing repeatedly;
 * it does nothing about a hundred *distinct* errors appearing at once, which is
 * what a bad deploy looks like. That is precisely when the inbox must stay
 * usable, so the flood is capped and the rest are left in the dashboard.
 */
const MAX_ALERTS_PER_HOUR = 12;

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
    const route = e.route ? sanitizeRoute(e.route) : undefined;
    const fingerprint = fingerprintFor({ source: e.source, message, stack: e.stack, route });

    // One statement does insert-or-bump and tells us whether this is new and
    // whether it's due an alert, so there's no read-then-write race between
    // two requests failing at the same instant.
    const row = await query<{ count: number; is_new: boolean; should_alert: boolean }>(
      // alerted_at is set on the initial INSERT for API errors, not only in the
      // conflict branch — a brand-new server error is precisely the one worth
      // hearing about, and leaving it NULL meant the first occurrence stayed
      // silent and the second reported itself as "recurring".
      //
      // Client errors start with NULL instead: they only earn an alert once
      // they've been seen enough times to be systematic rather than one
      // person's broken browser session.
      `INSERT INTO error_events (fingerprint, source, message, stack, route, method, status_code, alerted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $2 = 'client' THEN NULL ELSE now() END)
       ON CONFLICT (fingerprint) DO UPDATE SET
         count = error_events.count + 1,
         last_seen_at = now(),
         -- A recurrence re-opens something previously marked resolved: if it's
         -- back, it wasn't fixed.
         resolved_at = NULL,
         message = EXCLUDED.message,
         stack = COALESCE(EXCLUDED.stack, error_events.stack),
         alerted_at = CASE
           WHEN (error_events.alerted_at IS NULL
                 OR error_events.alerted_at < now() - ($8 || ' milliseconds')::interval)
            -- Client errors must additionally clear the volume threshold. Note
            -- this reads count + 1: error_events.count is still the pre-update
            -- value inside the SET list.
            AND (error_events.source <> 'client' OR error_events.count + 1 >= $9)
           THEN now() ELSE error_events.alerted_at END
       RETURNING count,
                 (count = 1) AS is_new,
                 -- Exact equality with now(), not "alerted_at looks recent".
                 --
                 -- This previously asked whether alerted_at was within the last
                 -- five seconds, which is true for every occurrence in the five
                 -- seconds AFTER an alert — so a crash loop firing a hundred
                 -- times a second sent a hundred emails before the cooldown
                 -- could do anything. The cooldown was working; the question
                 -- being asked of it was wrong.
                 --
                 -- now() is transaction_timestamp(), fixed for this statement
                 -- and distinct from any earlier transaction's. So equality is
                 -- true exactly when THIS statement set the field, which is the
                 -- actual question — and it stays race-free, because it's still
                 -- one statement doing the read, the write and the decision.
                 (alerted_at = now()) AS should_alert`,
      [fingerprint, e.source, message, stack, route ?? null, e.method ?? null,
        e.statusCode ?? null, String(REALERT_AFTER_MS), CLIENT_ALERT_MIN_COUNT],
    );

    const result = row.rows[0];
    if (!result?.should_alert) return;

    // Global hourly ceiling, checked only on the path that is about to send —
    // rare by construction, so the extra query costs nothing in the normal case.
    // Counted in the database rather than in this process so it still holds
    // with more than one API instance running.
    const recent = await query<{ count: string }>(
      "SELECT count(*) FROM error_events WHERE alerted_at > now() - interval '1 hour'",
    );
    if (Number(recent.rows[0]?.count ?? 0) > MAX_ALERTS_PER_HOUR) {
      console.warn(
        `[errors] suppressed alert for ${fingerprint.slice(0, 12)} — more than ${MAX_ALERTS_PER_HOUR} `
        + 'alerts already sent this hour. See the admin dashboard under Errors.',
      );
      return;
    }

    const where = route ? `${e.method ?? ''} ${route}`.trim() : e.source;
    // A client error that crosses the threshold is neither "new" (it has been
    // happening for a while) nor merely "recurring" — the notable thing is that
    // it spread, so the subject says which.
    const kind = e.source === 'client' && !result.is_new
      ? `Widespread client error (${result.count}×)`
      : `${result.is_new ? 'New' : 'Recurring'} ${e.source} error`;
    await sendOpsAlert(
      `${kind} — ${where}`,
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
