import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { maybeOne, query } from '../db.js';
import { auditFromReq } from '../lib/audit.js';
import { SESSION_COOKIE, requireUser } from '../plugins/auth.js';

/**
 * Active-session inventory.
 *
 * Sessions could already be revoked wholesale (on a password or 2FA change),
 * but nobody could see which sessions existed or drop one specific device —
 * "I signed in on a shared laptop last week" had no answer short of changing
 * the password. Enterprise security reviews ask for this by name.
 */

/** The session id of the request making the call, so the UI can mark it. */
function currentSessionId(req: { cookies?: Record<string, unknown>; headers: Record<string, unknown> }): string | null {
  const raw = (req.cookies?.[SESSION_COOKIE] as string | undefined)
    ?? (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined);
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, config.jwtSecret) as { sid?: string };
    return typeof payload.sid === 'string' ? payload.sid : null;
  } catch {
    return null;
  }
}

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/sessions', { preHandler: requireUser }, async (req) => {
    const res = await query<{
      id: string; created_at: string; last_seen_at: string; user_agent: string | null; ip: string | null;
    }>(
      `SELECT id, created_at, last_seen_at, user_agent, ip
       FROM user_sessions
       WHERE user_id = $1 AND revoked_at IS NULL
         -- Sessions outlive their JWT in the table; only show ones that could
         -- still be used, so the list matches reality.
         AND created_at > now() - interval '7 days'
       ORDER BY last_seen_at DESC`,
      [req.user.id],
    );
    const current = currentSessionId(req);
    return {
      sessions: res.rows.map((s) => ({
        id: s.id,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        userAgent: s.user_agent,
        ip: s.ip,
        current: s.id === current,
      })),
    };
  });

  // Sign out one specific device.
  app.delete('/auth/sessions/:id', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const gone = await maybeOne<{ id: string }>(
      `UPDATE user_sessions SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, req.user.id],
    );
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    await auditFromReq(req, 'session.revoke', { teamId: null, target: id });
    return { ok: true };
  });

  // Sign out everywhere except here — the "I think someone has my laptop"
  // button. Deliberately keeps the caller signed in so they can carry on
  // securing the account (change password, check tokens) without re-logging in.
  app.post('/auth/sessions/revoke-others', {
    preHandler: requireUser,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req) => {
    const current = currentSessionId(req);
    const res = await query(
      `UPDATE user_sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
      [req.user.id, current],
    );
    await auditFromReq(req, 'session.revoke_others', { teamId: null, target: req.user.email });
    return { ok: true, revoked: res.rowCount ?? 0 };
  });
}
