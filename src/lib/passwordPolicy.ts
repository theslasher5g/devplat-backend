import { createHash } from 'node:crypto';

/**
 * Password strength policy, enforced server-side. The frontend mirrors these
 * rules for live feedback, but this is the authority — a client can always be
 * bypassed, so registration/reset never trust it.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** Human-readable policy, shown in the UI and in API error details. */
export const PASSWORD_POLICY_TEXT =
  `At least ${PASSWORD_MIN_LENGTH} characters, with an uppercase letter, a lowercase letter, a number, and a special character.`;

/** Returns a list of unmet requirements — empty means the password passes. */
export function validatePasswordPolicy(password: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`must be at most ${PASSWORD_MAX_LENGTH} characters`);
  if (!/[a-z]/.test(password)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('must contain an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('must contain a number');
  // Anything that isn't a letter, digit, or whitespace counts as special —
  // deliberately broad so non-US keyboard layouts aren't penalised.
  if (!/[^A-Za-z0-9\s]/.test(password)) problems.push('must contain a special character');
  return problems;
}

/**
 * Check a password against Have I Been Pwned's breach corpus using the
 * k-anonymity range API: we send only the first 5 characters of the SHA-1
 * hash, and HIBP returns every suffix under that prefix. The full hash — and
 * therefore the password — never leaves this process, and HIBP cannot tell
 * which of the ~800 returned candidates (if any) was ours.
 *
 * Fails open: if HIBP is unreachable or slow, we return 0 rather than blocking
 * a legitimate signup on a third party's availability. The complexity policy
 * above still applies in that case.
 */
export async function breachCount(password: string): Promise<number> {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: {
        // Ask HIBP to pad the response with random entries so the response
        // size can't hint at how many real matches the prefix had.
        'Add-Padding': 'true',
        'User-Agent': 'devplat-api',
      },
    });
    if (!res.ok) return 0;
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [candidate, countRaw] = line.trim().split(':');
      if (candidate === suffix) {
        const count = Number(countRaw);
        return Number.isFinite(count) ? count : 0;
      }
    }
    return 0;
  } catch {
    return 0; // fail open — see doc comment
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full check used by registration and password reset: policy first (cheap,
 * local), then the breach lookup (network) only if the policy passes. Returns
 * an error message suitable for the API's `detail` field, or null when the
 * password is acceptable.
 */
export async function checkPassword(password: string): Promise<string | null> {
  const problems = validatePasswordPolicy(password);
  if (problems.length > 0) return `Password ${problems.join(', ')}.`;

  const breaches = await breachCount(password);
  if (breaches > 0) {
    return 'This password has appeared in a known data breach. Please choose a different one.';
  }
  return null;
}
