import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { maybeOne, query } from '../db.js';
import { sendSecurityAlertEmail } from './email.js';

/**
 * Notifications for account-security events.
 *
 * Until now the product sent mail for verification and password resets and
 * nothing else — so an attacker who got in could mint API tokens, turn off 2FA
 * or take over a team without the real owner ever hearing about it. These are
 * the events where silence is the actual risk.
 *
 * Every send is best-effort: security mail must never fail the action that
 * triggered it (turning 2FA off shouldn't 500 because Resend is down).
 */

function describeClient(req: FastifyRequest): string[] {
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
  const lines: string[] = [];
  if (req.ip) lines.push(`IP address: ${req.ip}`);
  if (ua) lines.push(`Device: ${ua.slice(0, 160)}`);
  return lines;
}

async function notify(req: FastifyRequest, email: string, headline: string, detail: string): Promise<void> {
  await sendSecurityAlertEmail(email, {
    headline,
    detail,
    whenText: new Date().toUTCString(),
    contextLines: describeClient(req),
    profileUrl: `${config.frontendUrl}/app/profile`,
  }).catch((err) => req.log.warn({ err, headline }, 'security alert email could not be sent'));
}

/** Fire-and-forget wrapper: these run alongside the response, never blocking it. */
function notifyAsync(req: FastifyRequest, email: string, headline: string, detail: string): void {
  void notify(req, email, headline, detail);
}

/**
 * A device fingerprint that doesn't store what it fingerprints: the user agent
 * plus the network prefix (/24, or /48 for IPv6), hashed. Using a prefix rather
 * than the exact address means a normal DHCP or mobile-network change doesn't
 * look like a new device, while a genuinely different network does.
 */
function fingerprint(req: FastifyRequest): string {
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
  const ip = req.ip ?? '';
  const prefix = ip.includes(':')
    ? ip.split(':').slice(0, 3).join(':')
    : ip.split('.').slice(0, 3).join('.');
  return createHash('sha256').update(`${ua}|${prefix}`).digest('hex');
}

/**
 * Records the device a successful login came from and, when it's one we've
 * never seen for this user, emails them. The very first device an account ever
 * uses is recorded silently — telling someone "new sign-in" seconds after they
 * created the account is noise, not signal.
 */
export async function noteLoginDevice(req: FastifyRequest, userId: string, email: string): Promise<void> {
  const fp = fingerprint(req);
  try {
    const known = await maybeOne<{ id: string }>(
      'SELECT id FROM known_devices WHERE user_id = $1 AND fingerprint = $2', [userId, fp],
    );
    if (known) {
      await query('UPDATE known_devices SET last_seen_at = now() WHERE id = $1', [known.id]);
      return;
    }
    const any = await maybeOne<{ c: string }>(
      'SELECT count(*) AS c FROM known_devices WHERE user_id = $1', [userId],
    );
    const isFirstEver = Number(any?.c ?? 0) === 0;
    await query(
      `INSERT INTO known_devices (user_id, fingerprint) VALUES ($1, $2)
       ON CONFLICT (user_id, fingerprint) DO UPDATE SET last_seen_at = now()`,
      [userId, fp],
    );
    if (!isFirstEver) {
      notifyAsync(req, email, 'New sign-in to your devplat account',
        'Your account was signed in to from a device or network we haven\'t seen before.');
    }
  } catch (err) {
    req.log.warn({ err }, 'could not record login device');
  }
}

export function notifyTokenCreated(req: FastifyRequest, email: string, label: string): void {
  notifyAsync(req, email, 'A new API token was created',
    `An API token named "${label}" was created for your team. Anyone holding it can start environments billed to you.`);
}

export function notifyTwoFactorDisabled(req: FastifyRequest, email: string): void {
  notifyAsync(req, email, 'Two-factor authentication was turned off',
    'Two-factor authentication has been removed from your account, so a password alone is now enough to sign in.');
}

export function notifyPasswordChanged(req: FastifyRequest, email: string): void {
  notifyAsync(req, email, 'Your password was changed',
    'The password for your devplat account was changed, and every other session was signed out.');
}

export function notifyOwnershipTransferred(req: FastifyRequest, email: string, teamName: string, newOwner: string): void {
  notifyAsync(req, email, `Ownership of ${teamName} was transferred`,
    `You are no longer the owner of ${teamName} — ${newOwner} is. You remain an admin, but billing and ownership now sit with them.`);
}
