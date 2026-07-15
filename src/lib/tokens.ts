import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 hex digest — used for one-time tokens and API tokens (which are
 *  high-entropy random strings, so a fast hash is appropriate). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Opaque one-time token for email verification / password reset / invites. */
export function generateOneTimeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** API token, e.g. dvp_ci_9AfK…  Plaintext is returned to the caller exactly once. */
export function generateApiToken(scope: 'ci:run' | 'dev:run'): { token: string; hash: string; prefix: string } {
  const kind = scope === 'ci:run' ? 'ci' : 'dev';
  const token = `dvp_${kind}_${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: `${token.slice(0, 11)}…` };
}

/** Shared secret for a devplat-agent host, e.g. dvp_agent_9AfK… Used
 *  bidirectionally (scheduler → agent calls, agent → scheduler heartbeat),
 *  so — unlike api_tokens — this is stored in plaintext, not hashed; see
 *  migrations/002_scheduler.sql for why. */
export function generateAgentToken(): string {
  return `dvp_agent_${randomBytes(32).toString('base64url')}`;
}
