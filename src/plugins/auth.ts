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
    /** The API token's id, when authenticated with one (for usage attribution). */
    apiTokenId?: string;
    /** Set when the request authenticated with a devplat-agent host token. */
    hostId?: string;
  }
}

/**
 * Sign a session JWT. When `sessionId` is given the token carries it as `sid`,
 * tying the JWT to a row in user_sessions so it can be listed and revoked
 * individually. Tokens without a `sid` (issued before session tracking) stay
 * valid until they expire — they just can't be revoked one at a time.
 */
export function signSession(userId: string, sessionId?: string): string {
  return jwt.sign(
    sessionId ? { sub: userId, sid: sessionId } : { sub: userId },
    config.jwtSecret,
    { expiresIn: '7d' },
  );
}

/** Records a new session and returns its id, for embedding in the JWT. */
export async function createSession(
  userId: string,
  req: { headers: Record<string, unknown>; ip?: string },
): Promise<string> {
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 400) : null;
  const row = await query<{ id: string }>(
    'INSERT INTO user_sessions (user_id, user_agent, ip) VALUES ($1, $2, $3) RETURNING id',
    [userId, ua, req.ip ?? null],
  );
  return row.rows[0].id;
}

/**
 * Issue a session for `userId` and set the cookie on `reply`. Used everywhere a
 * session is (re-)established: login, and the credential changes that revoke
 * all sessions and must hand the acting caller a fresh one.
 */
export async function establishSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sid = await createSession(req.user.id, req);
  reply.setCookie(SESSION_COOKIE, signSession(req.user.id, sid), sessionCookieOptions());
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

/** Accept only a bare semver (optionally v-prefixed) from the client-supplied
 *  version header and normalise it to the `vX.Y.Z` form the release paths use.
 *  Anything else — absent, `dev`, or malformed — yields null so it's ignored. */
function normalizeCliVersion(raw: string | string[] | undefined): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value || !/^v?\d+\.\d+\.\d+$/.test(value)) return null;
  return value.startsWith('v') ? value : `v${value}`;
}

async function loadUser(userId: string): Promise<(SessionUser & { sessionsValidFrom: string | null }) | null> {
  const row = await maybeOne<{
    id: string; email: string; email_verified_at: string | null; is_platform_admin: boolean;
    sessions_valid_from: string | null;
  }>(
    'SELECT id, email, email_verified_at, is_platform_admin, sessions_valid_from FROM users WHERE id = $1',
    [userId],
  );
  if (!row) return null;
  return {
    id: row.id, email: row.email, emailVerifiedAt: row.email_verified_at,
    isPlatformAdmin: row.is_platform_admin, sessionsValidFrom: row.sessions_valid_from,
  };
}

/** Revoke every session issued to this user before now, by moving their
 *  session cut-off forward. Called after a password change/reset and after
 *  enabling or disabling 2FA — the points where the user is either recovering
 *  from a suspected compromise or changing what "authenticated" means. */
export async function revokeSessions(userId: string): Promise<void> {
  await query('UPDATE users SET sessions_valid_from = now() WHERE id = $1', [userId]);
}

/** preHandler: requires a valid JWT session (cookie or Bearer JWT). */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const raw = (req.cookies?.[SESSION_COOKIE] as string | undefined) ?? bearerToken(req) ?? '';
  if (!raw || raw.startsWith('dvp_')) {
    reply.code(401).send({ error: 'authentication_required' });
    return reply;
  }
  let userId: string;
  let issuedAtMs = 0;
  let sessionId: string | null = null;
  try {
    const payload = jwt.verify(raw, config.jwtSecret) as { sub?: string; iat?: number; sid?: string };
    if (!payload.sub) throw new Error('no sub');
    userId = payload.sub;
    // jsonwebtoken always stamps iat; treat a token without one as unusable
    // rather than as "issued at the epoch", which would fail closed anyway.
    if (typeof payload.iat !== 'number') throw new Error('no iat');
    issuedAtMs = payload.iat * 1000;
    sessionId = typeof payload.sid === 'string' ? payload.sid : null;
  } catch {
    reply.code(401).send({ error: 'invalid_session' });
    return reply;
  }

  // A session revoked individually (from the active-sessions list) is dead even
  // though its JWT is still cryptographically valid and inside the global
  // cut-off. Tokens minted before session tracking carry no sid and skip this.
  if (sessionId) {
    const session = await maybeOne<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM user_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId],
    );
    if (!session || session.revoked_at) {
      reply.code(401).send({ error: 'session_revoked' });
      return reply;
    }
    // Keep "last seen" roughly current without a write on every single request:
    // only touch the row when it's more than a minute stale.
    void query(
      "UPDATE user_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'",
      [sessionId],
    ).catch(() => { /* best-effort telemetry, never fail the request */ });
  }
  const user = await loadUser(userId);
  if (!user) {
    reply.code(401).send({ error: 'invalid_session' });
    return reply;
  }
  // Sessions issued before the user's revocation cut-off are dead: a password
  // change or a 2FA change evicts everyone who was already signed in.
  // `iat` has whole-second resolution, so allow the same second through —
  // otherwise the token minted by the very request that bumped the cut-off
  // would invalidate itself.
  if (user.sessionsValidFrom && issuedAtMs + 1000 <= new Date(user.sessionsValidFrom).getTime()) {
    reply.code(401).send({ error: 'session_revoked' });
    return reply;
  }
  req.user = user;
}

/**
 * preHandler: requireUser + resolve which team the user is acting in.
 *
 * A user can belong to several teams. `users.active_team_id` records the one
 * they last switched to; it's only honoured if they're still a member of it
 * (they may have left, or been removed, since). Otherwise — and for everyone
 * who has never switched — this falls back to their oldest membership, which
 * is the behaviour that existed before multi-team was finished.
 */
export async function requireMember(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const denied = await requireUser(req, reply);
  if (denied) return denied;
  const row = await maybeOne<{ team_id: string; role: Membership['role'] }>(
    `SELECT tm.team_id, tm.role
     FROM team_members tm
     LEFT JOIN users u ON u.id = tm.user_id
     WHERE tm.user_id = $1
     ORDER BY (tm.team_id = u.active_team_id) DESC, tm.created_at
     LIMIT 1`,
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
    const row = await maybeOne<{ id: string; team_id: string; expired: boolean }>(
      `SELECT id, team_id, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(raw)],
    );
    if (!row) {
      reply.code(401).send({ error: 'invalid_api_token' });
      return reply;
    }
    // Distinguish expiry from "never existed": a CI job failing at 3am should
    // say why, and an expired token is a fixable state, not a compromise.
    if (row.expired) {
      reply.code(401).send({
        error: 'api_token_expired',
        detail: 'This API token has expired. Create a new one in the dashboard under API tokens.',
      });
      return reply;
    }
    // Opportunistically record the CLI version the caller advertises, alongside
    // the last-used stamp we already write. Validated to a bare (optionally
    // v-prefixed) semver and capped so a hostile client can't store junk; a
    // missing/`dev`/malformed header just leaves the column unchanged.
    const cliVersion = normalizeCliVersion(req.headers['x-devplat-cli-version']);
    await query(
      'UPDATE api_tokens SET last_used_at = now(), last_cli_version = COALESCE($2, last_cli_version) WHERE id = $1',
      [row.id, cliVersion],
    );
    req.apiTokenTeamId = row.team_id;
    req.apiTokenId = row.id;
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
