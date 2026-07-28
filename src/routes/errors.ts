import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { captureError } from '../lib/errorTracking.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

export default async function errorRoutes(app: FastifyInstance): Promise<void> {
  /*
   * Crash reports from the browser.
   *
   * Deliberately unauthenticated: the most important crash to hear about is
   * the one on the signup form, where by definition nobody is signed in. That
   * makes it an open write endpoint, so it is fenced accordingly — a tight
   * per-IP limit, hard length caps via the schema, and grouping by fingerprint
   * so repeated junk collapses into one row rather than growing the table.
   */
  app.post('/client-errors', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 1, maxLength: 1000 },
          stack: { type: 'string', maxLength: 4000 },
          // The SPA route, e.g. /app/profile — sent by the client rather than
          // derived, since the server never sees the client-side path.
          route: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const body = req.body as { message: string; stack?: string; route?: string };
    await captureError({
      source: 'client',
      message: body.message,
      stack: body.stack,
      route: body.route,
    });
    // 204: the browser has nothing to do with the answer, and a body would
    // just be something for a broken page to fail to parse.
    return reply.code(204).send();
  });

  app.get('/admin/errors', { preHandler: requirePlatformAdmin }, async (req) => {
    const q = req.query as { resolved?: string; source?: string };
    const includeResolved = q.resolved === 'true';
    const source = q.source === 'api' || q.source === 'client' ? q.source : null;

    const res = await query<{
      id: string; fingerprint: string; source: string; message: string; stack: string | null;
      route: string | null; method: string | null; status_code: number | null; count: number;
      first_seen_at: string; last_seen_at: string; resolved_at: string | null;
    }>(
      `SELECT id, fingerprint, source, message, stack, route, method, status_code,
              count, first_seen_at, last_seen_at, resolved_at
       FROM error_events
       WHERE ($1::boolean OR resolved_at IS NULL)
         AND ($2::text IS NULL OR source = $2)
       ORDER BY last_seen_at DESC
       LIMIT 100`,
      [includeResolved, source],
    );

    const totals = await query<{ unresolved: string; last_24h: string }>(
      `SELECT count(*) FILTER (WHERE resolved_at IS NULL) AS unresolved,
              COALESCE(sum(count) FILTER (WHERE last_seen_at > now() - interval '24 hours'), 0) AS last_24h
       FROM error_events`,
    );

    return {
      unresolved: Number(totals.rows[0].unresolved),
      occurrencesLast24h: Number(totals.rows[0].last_24h),
      errors: res.rows.map((r) => ({
        id: r.id,
        source: r.source,
        message: r.message,
        stack: r.stack,
        route: r.route,
        method: r.method,
        statusCode: r.status_code,
        count: r.count,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        resolvedAt: r.resolved_at,
      })),
    };
  });

  // Mark handled. Not a delete: keeping the row means a recurrence bumps the
  // same fingerprint, clears resolved_at, and alerts again — so an error that
  // was "fixed" and came back announces itself instead of hiding in history.
  app.patch('/admin/errors/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolved?: boolean } | undefined;
    const resolved = body?.resolved !== false;
    const res = await query(
      'UPDATE error_events SET resolved_at = $2, alerted_at = NULL WHERE id = $1',
      [id, resolved ? new Date().toISOString() : null],
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, resolved };
  });
}
