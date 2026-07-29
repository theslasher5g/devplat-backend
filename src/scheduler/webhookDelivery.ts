import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { config } from '../config.js';
import { query } from '../db.js';
import { SchedulerLock, lockedTick } from '../lib/advisoryLock.js';
import { guardedLookup } from '../lib/ssrfGuard.js';
import { signPayload } from '../lib/webhooks.js';

/** Backoff between attempts, in seconds. Six attempts spread over ~9 hours:
 *  long enough to ride out a customer's deploy or a short outage, short enough
 *  that a permanently dead endpoint stops consuming the queue by end of day. */
const BACKOFF_SECONDS = [10, 60, 300, 1_800, 7_200, 21_600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

/** Consecutive exhausted deliveries before an endpoint is switched off. An
 *  endpoint that has burned six attempts each on ten separate events isn't
 *  coming back on its own, and continuing to hammer it is both useless and
 *  rude — the receiving side may well read it as abuse. */
const DISABLE_AFTER_FAILURES = 10;

/** Per-attempt ceilings. A webhook receiver is a stranger's HTTP server: it can
 *  hang forever and it can answer with megabytes. */
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024;
const STORED_BODY_CHARS = 500;

/** Rows per tick. Bounded so one team's backlog can't starve every other team's
 *  deliveries, and so a tick stays comfortably shorter than its interval. */
const BATCH = 50;

interface DeliveryResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

/**
 * One HTTP attempt against a customer-controlled URL.
 *
 * node:https rather than fetch(), for two reasons that are both security ones:
 * it accepts a custom `lookup` (so the address we validate is the address the
 * socket dials — see lib/ssrfGuard.ts on DNS rebinding), and it does not follow
 * redirects, which would otherwise let a public URL bounce us to
 * 169.254.169.254 after every check has passed.
 */
function attemptDelivery(
  targetUrl: string, headers: Record<string, string>, body: string,
): Promise<DeliveryResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      return resolve({ ok: false, error: 'invalid URL' });
    }
    const isHttps = url.protocol === 'https:';
    if (!isHttps && !config.webhookAllowPrivateTargets) {
      return resolve({ ok: false, error: 'refusing plaintext http delivery' });
    }

    const send = isHttps ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (result: DeliveryResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = send(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
        timeout: REQUEST_TIMEOUT_MS,
        lookup: guardedLookup(config.webhookAllowPrivateTargets) as unknown as LookupFunction,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          // Past the cap we keep draining rather than destroying: a clean end
          // lets the socket be reused and avoids logging a spurious error for a
          // response that was otherwise perfectly fine.
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8').slice(0, STORED_BODY_CHARS);
          // 2xx only. A 3xx is a redirect we deliberately don't follow, and
          // treating it as success would silently drop the event.
          finish(status >= 200 && status < 300
            ? { ok: true, status, body: text }
            : { ok: false, status, body: text, error: `endpoint responded ${status}` });
        });
        res.on('error', (err) => finish({ ok: false, status: res.statusCode, error: err.message }));
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: `no response within ${REQUEST_TIMEOUT_MS / 1000}s` });
    });
    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.end(body);
  });
}

export async function processWebhookQueue(): Promise<void> {
  const due = await query<{
    id: string; endpoint_id: string; event_type: string; payload: unknown; attempts: number;
    url: string; secret: string;
  }>(
    `SELECT d.id, d.endpoint_id, d.event_type, d.payload, d.attempts, e.url, e.secret
     FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.enabled = true
     ORDER BY d.next_attempt_at ASC
     LIMIT $1`,
    [BATCH],
  );

  for (const row of due.rows) {
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const result = await attemptDelivery(row.url, {
      'content-type': 'application/json',
      'user-agent': 'devplat-webhooks/1',
      'devplat-event': row.event_type,
      'devplat-delivery': row.id,
      'devplat-signature': signPayload(row.secret, body, timestamp),
    }, body);

    const attempts = row.attempts + 1;

    if (result.ok) {
      await query(
        `UPDATE webhook_deliveries
         SET status = 'delivered', attempts = $2, response_status = $3, response_body = $4,
             error = NULL, delivered_at = now()
         WHERE id = $1`,
        [row.id, attempts, result.status ?? null, result.body ?? null],
      );
      // Any success clears the strike count — an endpoint that recovers should
      // not be disabled by failures it has since grown out of.
      await query(
        'UPDATE webhook_endpoints SET last_success_at = now(), consecutive_failures = 0 WHERE id = $1',
        [row.endpoint_id],
      );
      continue;
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    await query(
      `UPDATE webhook_deliveries
       SET status = $5, attempts = $2, response_status = $3, response_body = $6, error = $4,
           next_attempt_at = now() + ($7::int * interval '1 second')
       WHERE id = $1`,
      [
        row.id, attempts, result.status ?? null, result.error ?? 'delivery failed',
        exhausted ? 'failed' : 'pending', result.body ?? null,
        exhausted ? 0 : BACKOFF_SECONDS[attempts - 1] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1],
      ],
    );

    if (!exhausted) continue;

    // The delivery is dead, not just late. Count it against the endpoint, and
    // switch the endpoint off once it's clear nobody is listening.
    const bumped = await query<{ consecutive_failures: number }>(
      `UPDATE webhook_endpoints
       SET consecutive_failures = consecutive_failures + 1, last_failure_at = now()
       WHERE id = $1 RETURNING consecutive_failures`,
      [row.endpoint_id],
    );
    const failures = bumped.rows[0]?.consecutive_failures ?? 0;
    if (failures >= DISABLE_AFTER_FAILURES) {
      await query(
        `UPDATE webhook_endpoints
         SET enabled = false, disabled_reason = $2
         WHERE id = $1 AND enabled = true`,
        [
          row.endpoint_id,
          `Disabled automatically after ${failures} consecutive undeliverable events. `
          + `Last error: ${(result.error ?? 'delivery failed').slice(0, 200)}`,
        ],
      );
    }
  }
}

/** Runs the delivery sweep. Every few seconds so a webhook feels immediate;
 *  the query is a single indexed lookup on an empty queue. */
export function startWebhookWorker(intervalMs = 5_000): () => void {
  // Advisory-locked: two instances would each pick up the same due row and
  // deliver the same event twice. Receivers are told to be idempotent on the
  // event id, but sending duplicates we could have avoided is still wrong.
  const timer = setInterval(
    lockedTick('webhook delivery', SchedulerLock.webhookDelivery, processWebhookQueue),
    intervalMs,
  );
  return () => clearInterval(timer);
}
