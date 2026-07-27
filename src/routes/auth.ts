import type { FastifyInstance } from 'fastify';
import { maybeOne, one, query, withTransaction } from '../db.js';
import { auditFromReq } from '../lib/audit.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../lib/email.js';
import { hashPassword, verifyPassword, verifyPasswordConstantTime } from '../lib/passwords.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, checkPassword } from '../lib/passwordPolicy.js';
import { linkReferral } from '../lib/referral.js';
import { generateOneTimeToken, hashToken } from '../lib/tokens.js';
import { verifyTotp } from '../lib/totp.js';
import { getPlan } from '../plans.js';
import { SESSION_COOKIE, requireUser, revokeSessions, sessionCookieOptions, signSession } from '../plugins/auth.js';

const credentialsSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 255 },
    // Schema enforces length only; complexity + breach checks run in the
    // handler via checkPassword() so we can return a specific reason.
    password: { type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
    teamName: { type: 'string', minLength: 1, maxLength: 100 },
    referralCode: { type: 'string', maxLength: 32 },
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

/**
 * Validates the second factor for a login attempt. Returns null when the factor
 * is satisfied, or the error to send otherwise. Accepts either a TOTP code or
 * one single-use recovery code.
 *
 * Two replay defences: an accepted TOTP step is recorded so the same code can't
 * be reused inside its ±30s window, and a recovery code is atomically marked
 * used by the same UPDATE that validates it.
 */
async function verifySecondFactor(
  user: { id: string; totp_secret: string | null; totp_last_step: string | null },
  totpCode?: string,
  recoveryCode?: string,
): Promise<{ code: number; error: string } | null> {
  if (recoveryCode) {
    const used = await maybeOne<{ id: string }>(
      `UPDATE two_factor_recovery_codes SET used_at = now()
       WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
       RETURNING id`,
      [user.id, hashToken(recoveryCode.trim().toLowerCase())],
    );
    return used ? null : { code: 401, error: 'invalid_totp' };
  }

  if (!totpCode) return { code: 401, error: 'totp_required' };

  const result = verifyTotp(user.totp_secret!, totpCode);
  if (!result.ok) return { code: 401, error: 'invalid_totp' };
  // Reject a code that was already accepted for this step (replay within the
  // same 30s window, e.g. a stolen code racing the legitimate user).
  if (user.totp_last_step !== null && Number(user.totp_last_step) >= result.step) {
    return { code: 401, error: 'invalid_totp' };
  }
  await query('UPDATE users SET totp_last_step = $1 WHERE id = $2', [result.step, user.id]);
  return null;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', {
    schema: { body: credentialsSchema },
    // Account creation triggers a DB write + an outbound verification email;
    // cap it hard per IP so it can't be used to spam signups / bomb an
    // address's inbox via the verification mail.
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { email, password, teamName, referralCode } = req.body as { email: string; password: string; teamName?: string; referralCode?: string };
    const normalized = email.trim().toLowerCase();

    const weak = await checkPassword(password);
    if (weak) return reply.code(400).send({ error: 'weak_password', detail: weak });

    const existing = await maybeOne('SELECT 1 FROM users WHERE email = $1', [normalized]);
    if (existing) return reply.code(409).send({ error: 'email_taken' });

    const passwordHash = await hashPassword(password);
    // Users registering off a team invitation join that team instead of
    // getting their own auto-created one.
    const pendingInvite = await maybeOne(
      'SELECT 1 FROM team_invites WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()',
      [normalized],
    );
    const user = await withTransaction(async (tx) => {
      const u = await tx.query<{ id: string }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [normalized, passwordHash],
      );
      const userId = u.rows[0].id;
      let teamId: string | null = null;
      if (!pendingInvite) {
        // Trial length comes from the free plan's trial_duration_days (the
        // plans table is the single source of truth), not the teams column's
        // own DEFAULT — otherwise editing the plan row would silently have no
        // effect on new signups. Falls back to the column default (14d) only
        // if the plan somehow has no trial window configured.
        const trialDays = getPlan('free').trialDurationDays;
        const team = trialDays != null
          ? await tx.query<{ id: string }>(
              "INSERT INTO teams (name, trial_ends_at) VALUES ($1, now() + ($2 || ' days')::interval) RETURNING id",
              [teamName?.trim() || normalized.split('@')[0], String(trialDays)],
            )
          : await tx.query<{ id: string }>(
              'INSERT INTO teams (name) VALUES ($1) RETURNING id',
              [teamName?.trim() || normalized.split('@')[0]],
            );
        teamId = team.rows[0].id;
        await tx.query(
          "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')",
          [teamId, userId],
        );
      }
      return { id: userId, teamId };
    });

    // Link a referral if a valid code was supplied and a fresh team was created
    // (invite signups join an existing team and can't be referred). Best-effort.
    if (referralCode?.trim() && user.teamId) {
      await linkReferral(referralCode, user.teamId);
    }

    const token = await createOneTimeToken(user.id, 'verify_email');
    // Best-effort: the account is already committed above, so a Resend
    // outage/misconfiguration must not turn a successful signup into a 500.
    await sendVerificationEmail(normalized, token).catch((err) => {
      req.log.warn({ err }, 'verification email failed to send');
    });

    return reply.code(201).send({ ok: true, message: 'verification_email_sent' });
  });

  const loginSchema = {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 1, maxLength: 200 },
      // Second factor, only required for accounts with TOTP enabled. The client
      // learns it's needed from the `totp_required` error on the first attempt,
      // then re-submits the same credentials with a code (or a recovery code).
      totpCode: { type: 'string', maxLength: 20 },
      recoveryCode: { type: 'string', maxLength: 40 },
    },
  } as const;

  app.post('/auth/login', {
    schema: { body: loginSchema },
    // The brute-force surface: cap password attempts per IP. 10/min still
    // covers a human fat-fingering their password, but takes online
    // guessing off the table.
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { email, password, totpCode, recoveryCode } = req.body as {
      email: string; password: string; totpCode?: string; recoveryCode?: string;
    };
    const user = await maybeOne<{
      id: string; password_hash: string; email_verified_at: string | null;
      totp_secret: string | null; totp_enabled_at: string | null; totp_last_step: string | null;
    }>(
      `SELECT id, password_hash, email_verified_at, totp_secret, totp_enabled_at, totp_last_step
       FROM users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    // Always runs bcrypt, even when no such account exists, so the response
    // time can't be used to enumerate registered addresses. It returns false
    // whenever there was no real hash, so `user` is non-null past this point.
    const passwordOk = await verifyPasswordConstantTime(password, user?.password_hash);
    if (!passwordOk || !user) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (!user.email_verified_at) {
      return reply.code(403).send({ error: 'email_not_verified' });
    }

    // Second factor. Password alone is never enough once TOTP is enabled — the
    // session cookie is only issued past this block.
    if (user.totp_enabled_at && user.totp_secret) {
      const failed = await verifySecondFactor(user, totpCode, recoveryCode);
      if (failed) return reply.code(failed.code).send({ error: failed.error });
    }

    const jwt = signSession(user.id);
    return reply
      .setCookie(SESSION_COOKIE, jwt, sessionCookieOptions())
      .send({ ok: true, token: jwt });
  });

  app.post('/auth/logout', async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined }).send({ ok: true });
  });

  // Change password from the profile page. Requires the current password —
  // a stolen session alone must not be enough to lock the real owner out.
  app.post('/auth/change-password', {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', maxLength: PASSWORD_MAX_LENGTH },
          newPassword: { type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const weak = await checkPassword(newPassword);
    if (weak) return reply.code(400).send({ error: 'weak_password', detail: weak });
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), req.user.id]);
    // Evict every other session: changing a password is what someone does when
    // they think an attacker is already signed in.
    await revokeSessions(req.user.id);
    void auditFromReq(req, 'password.change', { target: req.user.email });
    // Re-issue this caller's own session so they aren't logged out by their
    // own action (the new token is minted after the cut-off).
    return reply
      .setCookie(SESSION_COOKIE, signSession(req.user.id), sessionCookieOptions())
      .send({ ok: true });
  });

  // Self-service account deletion. Password-gated, and refused for platform
  // admins and for team owners whose team has other members — the owner has to
  // hand over or delete the team first, so a team can't be orphaned.
  app.delete('/auth/me', {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string', maxLength: PASSWORD_MAX_LENGTH } },
      },
    },
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { password } = req.body as { password: string };
    const row = await one<{ password_hash: string; is_platform_admin: boolean }>(
      'SELECT password_hash, is_platform_admin FROM users WHERE id = $1', [req.user.id],
    );
    if (!(await verifyPassword(password, row.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (row.is_platform_admin) {
      return reply.code(400).send({ error: 'is_admin', detail: 'Platform admins cannot delete their own account here.' });
    }
    const ownedWithOthers = await maybeOne<{ team_id: string }>(
      `SELECT tm.team_id FROM team_members tm
       WHERE tm.user_id = $1 AND tm.role = 'owner'
         AND (SELECT count(*) FROM team_members o WHERE o.team_id = tm.team_id) > 1
       LIMIT 1`,
      [req.user.id],
    );
    if (ownedWithOthers) {
      return reply.code(409).send({
        error: 'owns_team',
        detail: 'You still own a team with other members. Transfer ownership or delete the team first.',
      });
    }
    // Teams where this user is the only member go with them, rather than being
    // left memberless. Everything else cascades from the users row.
    await withTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM teams WHERE id IN (
           SELECT tm.team_id FROM team_members tm
           WHERE tm.user_id = $1
             AND (SELECT count(*) FROM team_members o WHERE o.team_id = tm.team_id) = 1
         )`,
        [req.user.id],
      );
      await tx.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    });
    return reply.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined }).send({ ok: true });
  });

  app.get('/auth/me', { preHandler: requireUser }, async (req) => {
    // planTier here is the effective entitlement tier (a manual plan_override
    // if set, else the billing plan_tier), so the dashboard reflects what the
    // team can actually use. Billing/subscription state is under /billing.
    const membership = await maybeOne<{ team_id: string; role: string; name: string; plan_tier: string; trial_ends_at: string }>(
      `SELECT tm.team_id, tm.role, t.name, COALESCE(t.plan_override, t.plan_tier) AS plan_tier, t.trial_ends_at
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
    // Token is high-entropy so guessing is already infeasible; this just
    // keeps the endpoint from being a free DB-query amplifier.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { token } = req.body as { token: string };
    const row = await maybeOne<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM verification_tokens
       WHERE token_hash = $1 AND type = 'verify_email' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!row) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    const joinedTeamIds = await withTransaction(async (tx) => {
      await tx.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL', [row.user_id]);
      await tx.query('UPDATE verification_tokens SET used_at = now() WHERE id = $1', [row.id]);

      // A user who registered off a team invite (see /auth/register's
      // pendingInvite check) previously had to verify, sign in, THEN
      // re-open the original invite link a second time to actually join —
      // easy to lose track of. Auto-accept any pending invite(s) for this
      // email right here instead, so verifying is the only step left.
      const { rows: user } = await tx.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [row.user_id]);
      const { rows: invites } = await tx.query<{ id: string; team_id: string; role: 'admin' | 'developer' }>(
        `SELECT id, team_id, role FROM team_invites
         WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()`,
        [user[0].email],
      );
      for (const invite of invites) {
        await tx.query(
          `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (team_id, user_id) DO NOTHING`,
          [invite.team_id, row.user_id, invite.role],
        );
        await tx.query('UPDATE team_invites SET accepted_at = now() WHERE id = $1', [invite.id]);
      }
      return invites.map((i) => i.team_id);
    });
    return { ok: true, joinedTeamIds };
  });

  app.post('/auth/resend-verification', {
    schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } },
    // Sends an email to an attacker-supplied address — the classic mail-bomb
    // vector. Cap it tightly per IP.
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req) => {
    const { email } = req.body as { email: string };
    const user = await maybeOne<{ id: string; email: string; email_verified_at: string | null }>(
      'SELECT id, email, email_verified_at FROM users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    // Always answer OK to avoid leaking which addresses have accounts.
    if (user && !user.email_verified_at) {
      const token = await createOneTimeToken(user.id, 'verify_email');
      await sendVerificationEmail(user.email, token).catch((err) => {
        req.log.warn({ err }, 'verification email failed to send');
      });
    }
    return { ok: true };
  });

  app.post('/auth/forgot-password', {
    schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } },
    // Same mail-bomb vector as resend-verification: sends to an
    // attacker-supplied address.
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req) => {
    const { email } = req.body as { email: string };
    const user = await maybeOne<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    if (user) {
      const token = await createOneTimeToken(user.id, 'password_reset');
      await sendPasswordResetEmail(user.email, token).catch((err) => {
        req.log.warn({ err }, 'password reset email failed to send');
      });
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
          password: { type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { token, password } = req.body as { token: string; password: string };
    const row = await maybeOne<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM verification_tokens
       WHERE token_hash = $1 AND type = 'password_reset' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!row) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    // Same strength bar as registration — a reset must not be a way to
    // downgrade an account to a weak or breached password.
    const weak = await checkPassword(password);
    if (weak) return reply.code(400).send({ error: 'weak_password', detail: weak });
    const passwordHash = await hashPassword(password);
    await withTransaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, row.user_id]);
      await tx.query('UPDATE verification_tokens SET used_at = now() WHERE id = $1', [row.id]);
      // A reset proves control of the mailbox — count it as verification too.
      await tx.query('UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL', [row.user_id]);
      // A reset is the account-recovery path; anyone already signed in as this
      // user (i.e. the reason for the reset) is signed out.
      await tx.query('UPDATE users SET sessions_valid_from = now() WHERE id = $1', [row.user_id]);
    });
    return { ok: true };
  });
}
