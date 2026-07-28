import { createHash } from 'node:crypto';

/**
 * Pure helpers for error grouping and redaction.
 *
 * Split from errorTracking.ts so they can be tested without a database: that
 * module reaches config and the pool at import time, and the test suite's
 * whole value is that it runs anywhere, instantly, with nothing set up.
 */

/**
 * Strips things that must not be persisted even inside an error message.
 *
 * Error strings are assembled from whatever was in scope, so they routinely
 * carry the token that failed to parse or the address of the user it happened
 * to. The error table is read by platform admins and sits in every backup — it
 * must not quietly become a second, unaudited copy of that data.
 */
export function redact(text: string): string {
  return text
    .replace(/dvp_[A-Za-z0-9_-]+/g, 'dvp_[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\b(sk|pk|whsec|rk)_[A-Za-z0-9_]{8,}/g, '$1_[redacted]');
}

/**
 * Normalises a message so occurrences differing only in embedded values land
 * on one fingerprint. Without it, `duplicate key ... (id)=(abc)` and the same
 * error for a different id would look like two separate problems.
 */
export function normalize(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/"[^"]{0,200}"/g, '"<str>"')
    .slice(0, 300);
}

/** First frame that isn't node internals — the line that actually says where
 *  this error comes from. */
export function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  for (const line of stack.split('\n').slice(1)) {
    const t = line.trim();
    if (t.startsWith('at ') && !t.includes('node:internal')) return t.slice(0, 200);
  }
  return '';
}

/** Stable grouping key for one error. */
export function fingerprint(parts: {
  source: string; message: string; stack?: string; route?: string;
}): string {
  return createHash('sha256')
    .update([parts.source, normalize(parts.message), topFrame(parts.stack), parts.route ?? ''].join('|'))
    .digest('hex')
    .slice(0, 32);
}
