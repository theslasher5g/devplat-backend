import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signing and event names for outgoing webhooks.
 *
 * Deliberately separate from lib/webhooks.ts, which touches the database:
 * everything here is pure, so it can be unit-tested (and pasted into the docs
 * as a reference implementation) without a Postgres connection.
 */

/** Events a team can subscribe to. Names are part of the public contract —
 *  renaming one silently stops delivering to every endpoint that asked for it,
 *  so treat this list as append-only. */
export const WEBHOOK_EVENTS = [
  'environment.assigned',
  'environment.released',
  'environment.failed',
  'environment.queued_at_limit',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Signing secret handed to the customer once, at creation, and on rotation. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Signature header value: `t=<unix seconds>,v1=<hex hmac>`.
 *
 * The timestamp is inside the signed material, not merely alongside it. That is
 * the whole point of the scheme: a receiver can reject a payload older than
 * their tolerance and know the timestamp wasn't rewritten, which is what makes
 * a captured delivery non-replayable. Signing the body alone would leave every
 * past payload valid forever.
 *
 * `v1=` is a version tag so a future algorithm change can be rolled out by
 * sending both, rather than by breaking every receiver at once.
 */
export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

/** Verifies a signature header. The backend never receives its own webhooks —
 *  this exists so the documented verification steps are actually executed by a
 *  test, rather than only described in prose that could drift from the signer. */
export function verifySignature(
  secret: string, body: string, header: string, toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2)).filter((p) => p.length === 2) as [string, string][],
  );
  const t = Number(parts.t);
  if (!parts.t || !Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const got = parts.v1 ?? '';
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length of a hex digest isn't a secret anyway.
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
