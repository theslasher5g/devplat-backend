import type { FastifyInstance } from 'fastify';
import { maybeOne, query, withTransaction } from '../db.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../lib/email.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { generateOneTimeToken, hashToken } from '../lib/tokens.js';
import { SESSION_COOKIE, requireUser, sessionCookieOptions, signSession } from '../plugins/auth.js';

const credentialsSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 255 },
    password: { type: 'string', minLength: 10, maxLength: 200 },
    teamName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

async function createOneTimeToken(userId: string, type: 'verify_email' | 'password_reset', ttlHours = 24): Promise<string> {
  const { token, hash } = generateOneTimeToken();
  // Invalidate previous tokens of the same type so only the latest link works.
  await query('DELETE FROM verification_tokens WHERE user_id = $1 AND type = $2', [userId, type]);
  await query(
    `INSERT INTO verification_tokens (user_id, token_hash, expires_at, type)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4)`,
    [userId, hash, String(ttlHours), type],
  );
  return token;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', { schema: { body: credentialsSchema }, config: { rateLimit: true } }, async (req, reply) => {
    const { email, password, teamName } = req.body as { email: string; password: string; teamName?: string };
    const normalized = email.trim().toLowerCase();

    const existing = await maybeOne('SELECT 1 FROM users WHERE email = $1', [normalized]);
    if (existing) return reply.code(409).send({ error: 'email_taken' });

    const passwordHash = await hashPassword(password);
    const user = await withTransaction(async (tx) => {
      const u = await tx.query<{ id: string }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [normalized, passwordHash],
      );
      const userId = u.rows[0].id;
      const team = await tx.query<{ id: string }>(
        'INSERT INTO teams (name) VALUES ($1) RETURNING id',
        [teamName?.trim() || normalized.split('@')[0]],
      );
      await tx.query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')",
        [team.rows[0].id, userId],
      );
      return { id: userId };
    });

    const token = await createOneTimeToken(user.id, 'verify_email');
    await sendVerificationEmail(normalized, token);

    return reply.code(201).send({ ok: true, message: 'verification_email_sent' });
  });

  const loginSchema = {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 1, maxLength: 200 },
    },
  } as const;

  app.post('/auth/login', { schema: { body: loginSchema } }, async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await maybeOne<{ id: string; password_hash: string; email_verified_at: string | null }>(
      'SELECT id, password_hash, email_verified_at FROM users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (!user.email_verified_at) {
      return reply.code(403).send({ error: 'email_not_verified' });
    }
    const jwt = signSession(user.id);
    return reply
      .setCookie(SESSION_COOKIE, jwt, sessionCookieOptions())
      .send({ ok: true, token: jwt });
  });

  app.post('/auth/logout', async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined }).send({ ok: true });
  });

  app.get('/auth/me', { preHandler: requireUser }, async (req) => {
    const membership = await maybeOne<{ team_id: string; role: string; name: string; plan_tier: string; trial_ends_at: string }>(
      `SELECT tm.team_id, tm.role, t.name, t.plan_tier, t.trial_ends_at
       FROM team_members tm JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = $1 ORDER BY tm.created_at LIMIT 1`,
      [req.user.id],
    );
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        emailVerified: !!req.user.emailVerifiedAt,
        isPlatformAdmin: req.user.isPlatformAdmin,
      },
      team: membership
        ? {
            id: membership.team_id,
            name: membership.name,
            role: membership.role,
            planTier: membership.plan_tier,
            trialEndsAt: membership.trial_ends_at,
          }
        : null,
    };
  });

  app.post('/auth/verify-email', {
    schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const { token } = req.body as { token: string };
    const row = await maybeOne<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM verification_tokens
       WHERE token_hash = $1 AND type = 'verify_email' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!row) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    await withTransaction(async (tx) => {
      await tx.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL', [row.user_id]);
      await tx.query('UPDATE verification_tokens SET used_at = now() WHERE id = $1', [row.id]);
    });
    return { ok: true };
  });

  app.post('/auth/resend-verification', {
    schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } },
  }, async (req) => {
    const { email } = req.body as { email: string };
    const user = await maybeOne<{ id: string; email: string; email_verified_at: string | null }>(
      'SELECT id, email, email_verified_at FROM users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    // Always answer OK to avoid leaking which addresses have accounts.
    if (user && !user.email_verified_at) {
      const token = await createOneTimeToken(user.id, 'verify_email');
      await sendVerificationEmail(user.email, token);
    }
    return { ok: true };
  });

  app.post('/auth/forgot-password', {
    schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } },
  }, async (req) => {
    const { email } = req.body as { email: string };
    const user = await maybeOne<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    if (user) {
      const token = await createOneTimeToken(user.id, 'password_reset');
      await sendPasswordResetEmail(user.email, token);
    }
    return { ok: true };
  });

  app.post('/auth/reset-password', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'password'],
        properties: {
          token: { type: 'string', maxLength: 200 },
          password: { type: 'string', minLength: 10, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { token, password } = req.body as { token: string; password: string };
    const row = await maybeOne<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM verification_tokens
       WHERE token_hash = $1 AND type = 'password_reset' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!row) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    const passwordHash = await hashPassword(password);
    await withTransaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, row.user_id]);
      await tx.query('UPDATE verification_tokens SET used_at = now() WHERE id = $1', [row.id]);
      // A reset proves control of the mailbox — count it as verification too.
      await tx.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL', [row.user_id]);
    });
    return { ok: true };
  });
}
