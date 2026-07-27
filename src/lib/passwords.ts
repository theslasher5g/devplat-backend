import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A real bcrypt hash of a value nobody can supply, computed once at startup.
 * Lets the "no such account" path burn the same ~250ms as a real verification.
 */
const DUMMY_HASH = bcrypt.hashSync('devplat-nonexistent-user-placeholder', ROUNDS);

/**
 * Verify a password against a hash that may be absent because the account
 * doesn't exist. Always runs a full bcrypt comparison — against DUMMY_HASH
 * when there is no real hash — so response time doesn't reveal whether an
 * email is registered. Without this, the short-circuit on a missing user
 * returns in ~2ms versus ~250ms for a real account, which is a reliable
 * enumeration oracle even over a noisy network.
 */
export async function verifyPasswordConstantTime(plain: string, hash: string | null | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return hash ? ok : false;
}
