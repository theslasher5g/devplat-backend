import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { maybeOne, query } from '../db.js';
import { generateApiToken, hashToken } from '../lib/tokens.js';
import { requireApiTokenOrUser, requireMember } from '../plugins/auth.js';

// How long a started login request stays valid before the user must run
// `devplat login` again, and how often the CLI is told to poll.
const DEVICE_CODE_TTL_SECONDS = 600; // 10 minutes
const POLL_INTERVAL_SECONDS = 5;

// User-code alphabet: no 0/O/1/I/L/U — unambiguous when read off a screen and
// typed by hand. 8 chars shown grouped as XXXX-XXXX.
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function generateUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalize a user-typed code: uppercase, strip everything but the alphabet,
 *  re-group. Tolerates missing/extra hyphens, spaces, and lowercase. */
function normalizeUserCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === 8 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

/**
 * Device-authorization flow backing `devplat login`. The CLI has no browser
 * and no session cookie, so it can't use /auth/login directly; instead it
 * starts a request here, the user approves it from the authenticated
 * dashboard by typing a short code, and the CLI polls until a normal
 * `dvp_dev_…` API token is minted — after which the entire rest of the stack
 * (tunnel, environments) authenticates exactly as it does for a
 * dashboard-created token. Nothing downstream needs to know a token came from
 * login rather than the Tokens page.
 */
export default async function deviceAuthRoutes(app: FastifyInstance): Promise<void> {
  // Step 1 (CLI, unauthenticated): begin a login request.
  app.post('/auth/device/start', {
    // A DB write per call and the only way to fill the table; cap per IP.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (_req, reply) => {
    // Opportunistically drop long-dead rows so the table stays small without a
    // dedicated sweeper.
    await query("DELETE FROM device_auth_requests WHERE expires_at < now() - interval '1 hour'");

    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = generateUserCode();
    await query(
      `INSERT INTO device_auth_requests (device_code_hash, user_code_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [hashToken(deviceCode), hashToken(userCode), String(DEVICE_CODE_TTL_SECONDS)],
    );
    return reply.code(201).send({
      deviceCode,
      userCode,
      verificationUri: `${config.frontendUrl}/activate`,
      verificationUriComplete: `${config.frontendUrl}/activate?code=${encodeURIComponent(userCode)}`,
      expiresIn: DEVICE_CODE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    });
  });

  // Step 2 (dashboard, authenticated): approve a pending request by its code.
  app.post('/auth/device/approve', {
    preHandler: requireMember,
    schema: {
      body: { type: 'object', required: ['userCode'], properties: { userCode: { type: 'string', minLength: 6, maxLength: 32 } } },
    },
  }, async (req, reply) => {
    const { userCode } = req.body as { userCode: string };
    const row = await maybeOne<{ id: string }>(
      `UPDATE device_auth_requests
       SET status = 'approved', team_id = $1, approved_by = $2
       WHERE user_code_hash = $3 AND status = 'pending' AND expires_at > now()
       RETURNING id`,
      [req.membership.teamId, req.user.id, hashToken(normalizeUserCode(userCode))],
    );
    if (!row) return reply.code(404).send({ error: 'invalid_or_expired_code' });
    return { ok: true };
  });

  // Step 3 (CLI, unauthenticated): poll until the request is approved, then
  // receive a freshly minted API token exactly once.
  app.post('/auth/device/token', {
    schema: { body: { type: 'object', required: ['deviceCode'], properties: { deviceCode: { type: 'string', minLength: 1, maxLength: 200 } } } },
    // Polled ~every 5s for up to 10min (~120 calls); 60/min leaves headroom
    // over that while still bounding abuse.
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { deviceCode } = req.body as { deviceCode: string };
    const request = await maybeOne<{ id: string; status: string; team_id: string | null; expires_at: string }>(
      `SELECT id, status, team_id, expires_at FROM device_auth_requests WHERE device_code_hash = $1`,
      [hashToken(deviceCode)],
    );
    if (!request) return reply.code(400).send({ error: 'invalid_device_code' });

    await query('UPDATE device_auth_requests SET last_polled_at = now() WHERE id = $1', [request.id]);

    if (request.status === 'completed') return reply.code(400).send({ error: 'already_completed' });
    if (request.status === 'denied') return { status: 'denied' };
    if (new Date(request.expires_at) < new Date()) return reply.code(400).send({ error: 'expired_token' });
    if (request.status === 'pending') return { status: 'pending' };

    // Approved: mint the token and mark completed in one shot. The conditional
    // UPDATE guarantees only the first poll that sees 'approved' mints a token
    // (a concurrent duplicate poll gets 0 rows and falls through to the
    // already-handled/expired paths on retry), so a device_code is single-use.
    const claimed = await maybeOne<{ id: string; team_id: string }>(
      "UPDATE device_auth_requests SET status = 'completed' WHERE id = $1 AND status = 'approved' RETURNING id, team_id",
      [request.id],
    );
    if (!claimed || !claimed.team_id) return reply.code(400).send({ error: 'already_completed' });

    const { token, hash, prefix } = generateApiToken('dev:run');
    await query(
      `INSERT INTO api_tokens (team_id, label, token_prefix, scope, token_hash)
       VALUES ($1, $2, $3, 'dev:run', $4)`,
      [claimed.team_id, 'devplat login (CLI)', prefix, hash],
    );
    return { status: 'complete', token, apiUrl: config.apiUrl };
  });

  // Self-revoke: lets `devplat logout` invalidate the token it holds
  // server-side (the dashboard's DELETE /tokens/:id needs a session, which the
  // CLI doesn't have). Authenticated by the token itself; revoking an already
  // revoked/unknown token is a no-op success so logout is idempotent.
  app.delete('/auth/token', { preHandler: requireApiTokenOrUser }, async (req) => {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (raw.startsWith('dvp_')) {
      await query('UPDATE api_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(raw)]);
    }
    return { ok: true };
  });
}
