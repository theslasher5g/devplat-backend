import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) with the parameters every authenticator app defaults to:
 * SHA-1, 6 digits, 30-second steps. Implemented directly on node:crypto rather
 * than pulling in a dependency — it's ~60 lines, and an auth primitive is
 * exactly the kind of code worth not delegating to an unaudited package.
 */
const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** How many steps either side of "now" are accepted, to tolerate clock skew
 *  between the server and the user's phone. 1 = ±30s, the common choice. */
const SKEW_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the encoding authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32-encoded for the enrolment QR / manual entry. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one 30-second step. Exported for tests. */
export function codeForStep(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  // Big-endian 64-bit counter. Steps stay well inside 2^32 for ~4000 years,
  // so writing the low word is sufficient and avoids BigInt juggling.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * Verify a user-supplied code against the secret, accepting ±SKEW_STEPS.
 * Returns the matched step so callers can persist it and refuse replays of the
 * same code within its validity window.
 */
export function verifyTotp(secretBase32: string, code: string, atMs = Date.now()): { ok: boolean; step: number } {
  const trimmed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(trimmed)) return { ok: false, step: 0 };
  const current = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset++) {
    const step = current + offset;
    const expected = codeForStep(secretBase32, step);
    // Constant-time compare so a timing side channel can't leak digits.
    const a = Buffer.from(expected);
    const b = Buffer.from(trimmed);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, step };
  }
  return { ok: false, step: 0 };
}

/** otpauth:// URI for the enrolment QR code. */
export function otpauthUri(secretBase32: string, accountEmail: string, issuer = 'devplat'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Recovery codes for when the authenticator device is lost. Returned once in
 *  plaintext at enrolment; only hashes are stored (see routes/twofactor.ts). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10 hex chars, dash-grouped for legibility: "a1b2c-3d4e5"
    const raw = randomBytes(5).toString('hex');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
