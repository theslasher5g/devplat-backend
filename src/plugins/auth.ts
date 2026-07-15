import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { maybeOne, query } from '../db.js';
import { hashToken } from '../lib/tokens.js';

export const SESSION_COOKIE = 'devplat_session';

export interface SessionUser {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  isPlatformAdmin: boolean;
}

export interface Membership {
  teamId: string;
  role: 'owner' | 'admin' | 'developer';
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser;
    membership: Membership;
    /** Set when the request authenticated with an API token instead of a session. */
    apiTokenTeamId?: string;
    /** Set when the request authenticated with a devplat-agent host token. */
    hostId?: string;
  }
}

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '7d' });
}

export function sessionCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax' as const,
    domain: config.cookieDomain,
    maxAge: 7 * 24 * 3600,
  };
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function loadUser(userId: string): Promise<SessionUser | null> {
  const row = await maybeOne<{
    id: string; email: string; email_verified_at: string | null; is_platform_admin: boolean;
  }>('SELECT id, email, email_verified_at, is_platform_admin FROM users WHERE id = $1', [userId]);
  if (!row) return null;
  return { id: row.id, email: row.email, emailVerifiedAt: row.email_verified_at, isPlatformAdmin: row.is_platform_admin };
}

/** preHandler: requires a valid JWT session (cookie or Bearer JWT). */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const raw = (req.cookies?.[SESSION_COOKIE] as string | undefined) ?? bearerToken(req) ?? '';
  if (!raw || raw.startsWith('dvp_')) {
    reply.code(401).send({ error: 'authentication_required' });
    return reply;
  }
  let userId: string;
  try {
    const payload = jwt.verify(raw, config.jwtSecret) as { sub?: string };
    if (!payload.sub) throw new Error('no sub');
    userId = payload.sub;
  } catch {
    reply.code(401).send({ error: 'invalid_session' });
    return reply;
  }
  const user = await loadUser(userId);
  if (!user) {
    reply.code(401).send({ error: 'invalid_session' });
    return reply;
  }
  req.user = user;
}

/** preHandler: requireUser + resolve the user's team membership. */
export async function requireMember(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const denied = await requireUser(req, reply);
  if (denied) return denied;
  const row = await maybeOne<{ team_id: string; role: Membership['role'] }>(
    'SELECT team_id, role FROM team_members WHERE user_id = $1 ORDER BY created_at LIMIT 1',
    [req.user.id],
  );
  if (!row) {
    reply.code(403).send({ error: 'no_team' });
    return reply;
  }
  req.membership = { teamId: row.team_id, role: row.role };
}

/** preHandler: requireMember with role owner or admin. */
export async function requireTeamAdmin(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const denied = await requireMember(req, reply);
  if (denied) return denied;
  if (req.membership.role === 'developer') {
    reply.code(403).send({ error: 'admin_role_required' });
    return reply;
  }
}

/** preHandler: platform-level admin (for /admin endpoints). */
export async function requirePlatformAdmin(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const denied = await requireUser(req, reply);
  if (denied) return denied;
  if (!req.user.isPlatformAdmin) {
    reply.code(403).send({ error: 'platform_admin_required' });
    return reply;
  }
}

/**
 * preHandler for machine endpoints (e.g. the future scheduler asking for
 * team limits): accepts either a `dvp_…` API token or a user session.
 */
export async function requireApiTokenOrUser(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const raw = bearerToken(req);
  if (raw?.startsWith('dvp_')) {
    const row = await maybeOne<{ id: string; team_id: string }>(
      'SELECT id, team_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(raw)],
    );
    if (!row) {
      reply.code(401).send({ error: 'invalid_api_token' });
      return reply;
    }
    await query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id]);
    req.apiTokenTeamId = row.team_id;
    return;
  }
  return requireMember(req, reply);
}

/**
 * preHandler for devplat-agent → scheduler calls (currently just the
 * heartbeat endpoint). The agent has no direct Postgres access — hosts run
 * on separate hardware reachable only via WireGuard, and Postgres itself
 * has no public port mapping — so this is the only channel for agents to
 * report status, authenticated with the per-host shared secret issued at
 * registration.
 */
export async function requireAgentToken(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const raw = bearerToken(req);
  if (!raw?.startsWith('dvp_agent_')) {
    reply.code(401).send({ error: 'agent_token_required' });
    return reply;
  }
  const row = await maybeOne<{ id: string }>(
    'SELECT id FROM hosts WHERE agent_token = $1',
    [raw],
  );
  if (!row) {
    reply.code(401).send({ error: 'invalid_agent_token' });
    return reply;
  }
  req.hostId = row.id;
}
