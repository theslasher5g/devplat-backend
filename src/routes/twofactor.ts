import type { FastifyInstance } from 'fastify';
import { maybeOne, one, query, withTransaction } from '../db.js';
import { auditFromReq } from '../lib/audit.js';
import { verifyPassword } from '../lib/passwords.js';
import { hashToken } from '../lib/tokens.js';
import { generateRecoveryCodes, generateSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { SESSION_COOKIE, requireUser, revokeSessions, sessionCookieOptions, signSession } from '../plugins/auth.js';

/**
 * TOTP two-factor enrolment and removal. The pattern throughout: a secret that
 * has been generated but not confirmed does nothing — `totp_enabled_at` is what
 * login checks — so an interrupted setup leaves the account exactly as it was.
 */
export default async function twoFactorRoutes(app: FastifyInstance): Promise<void> {
  // Whether 2FA is on, plus how many recovery codes remain unused.
  app.get('/auth/2fa', { preHandler: requireUser }, async (req) => {
    const row = await one<{ totp_enabled_at: string | null }>(
      'SELECT totp_enabled_at FROM users WHERE id = $1', [req.user.id],
    );
    const remaining = await one<{ count: string }>(
      'SELECT count(*) FROM two_factor_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [req.user.id],
    );
    return {
      enabled: row.totp_enabled_at !== null,
      enabledAt: row.totp_enabled_at,
      recoveryCodesRemaining: Number(remaining.count),
    };
  });

  // Step 1: mint a secret and hand back the otpauth URI for the QR code. Called
  // again while setup is pending simply replaces the unconfirmed secret.
  app.post('/auth/2fa/setup', {
    preHandler: requireUser,
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const row = await one<{ totp_enabled_at: string | null }>(
      'SELECT totp_enabled_at FROM users WHERE id = $1', [req.user.id],
    );
    if (row.totp_enabled_at) {
      return reply.code(409).send({ error: 'already_enabled', detail: 'Disable two-factor authentication first to re-enrol.' });
    }
    const secret = generateSecret();
    await query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret, req.user.id]);
    return { secret, otpauthUri: otpauthUri(secret, req.user.email) };
  });

  // Step 2: prove the authenticator works, then switch 2FA on and issue
  // recovery codes. Returned in plaintext exactly once — only hashes persist.
  app.post('/auth/2fa/enable', {
    preHandler: requireUser,
    schema: {
      body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } },
    },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { code } = req.body as { code: string };
    const row = await one<{ totp_secret: string | null; totp_enabled_at: string | null }>(
      'SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1', [req.user.id],
    );
    if (row.totp_enabled_at) return reply.code(409).send({ error: 'already_enabled' });
    if (!row.totp_secret) return reply.code(400).send({ error: 'setup_required', detail: 'Start with POST /auth/2fa/setup.' });

    const result = verifyTotp(row.totp_secret, code);
    if (!result.ok) return reply.code(400).send({ error: 'invalid_totp', detail: 'That code is not valid — check your device clock and try the current code.' });

    const codes = generateRecoveryCodes();
    await withTransaction(async (tx) => {
      await tx.query(
        'UPDATE users SET totp_enabled_at = now(), totp_last_step = $1 WHERE id = $2',
        [result.step, req.user.id],
      );
      // Replace any codes from a previous enrolment.
      await tx.query('DELETE FROM two_factor_recovery_codes WHERE user_id = $1', [req.user.id]);
      for (const c of codes) {
        await tx.query(
          'INSERT INTO two_factor_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
          [req.user.id, hashToken(c)],
        );
      }
    });
    // Turning 2FA on should evict sessions that were established with only a
    // password — otherwise an attacker already signed in keeps their access.
    await revokeSessions(req.user.id);
    void auditFromReq(req, '2fa.enable', { target: req.user.email });
    return reply
      .code(201)
      .setCookie(SESSION_COOKIE, signSession(req.user.id), sessionCookieOptions())
      .send({ ok: true, recoveryCodes: codes });
  });

  // Turning 2FA off is a downgrade of the account's security, so it needs the
  // password AND a current code — knowing the session cookie alone isn't enough.
  app.post('/auth/2fa/disable', {
    preHandler: requireUser,
    schema: {
      body: {
        type: 'object',
        required: ['password', 'code'],
        properties: {
          password: { type: 'string', maxLength: 200 },
          code: { type: 'string', maxLength: 40 },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { password, code } = req.body as { password: string; code: string };
    const row = await one<{ password_hash: string; totp_secret: string | null; totp_enabled_at: string | null }>(
      'SELECT password_hash, totp_secret, totp_enabled_at FROM users WHERE id = $1', [req.user.id],
    );
    if (!row.totp_enabled_at) return reply.code(400).send({ error: 'not_enabled' });
    if (!(await verifyPassword(password, row.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    // Accept a TOTP code or a recovery code — someone who lost their device
    // must still be able to turn it off with a recovery code they wrote down.
    let ok = row.totp_secret ? verifyTotp(row.totp_secret, code).ok : false;
    if (!ok) {
      const used = await maybeOne<{ id: string }>(
        `UPDATE two_factor_recovery_codes SET used_at = now()
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
        [req.user.id, hashToken(code.trim().toLowerCase())],
      );
      ok = !!used;
    }
    if (!ok) return reply.code(400).send({ error: 'invalid_totp' });

    await withTransaction(async (tx) => {
      await tx.query(
        'UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1',
        [req.user.id],
      );
      await tx.query('DELETE FROM two_factor_recovery_codes WHERE user_id = $1', [req.user.id]);
    });
    await revokeSessions(req.user.id);
    void auditFromReq(req, '2fa.disable', { target: req.user.email });
    return reply
      .setCookie(SESSION_COOKIE, signSession(req.user.id), sessionCookieOptions())
      .send({ ok: true });
  });
}
