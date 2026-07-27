/**
 * CIDR validation for API-token IP allowlists.
 *
 * Matching itself is done by Postgres (`inet <<= ANY(cidr[])`), which is the
 * correct place for subnet arithmetic. This only has to reject input before it
 * reaches the database: a bad value would either error the INSERT with a raw
 * Postgres message, or — worse for the user — be accepted in a shape they
 * didn't intend and quietly lock a CI pipeline out.
 *
 * Accepts a bare address or an address with a prefix length. Note Postgres's
 * `cidr` type additionally requires host bits to be zero (so 203.0.113.4/24 is
 * rejected there); we surface that as its own message rather than a 500.
 */

function isIpv4(part: string): boolean {
  const octets = part.split('.');
  if (octets.length !== 4) return false;
  return octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

function isIpv6(part: string): boolean {
  // Reject obvious malformations; full IPv6 grammar is Postgres's job. Must be
  // hex groups separated by colons, with at most one "::" elision.
  if (!/^[0-9a-fA-F:]+$/.test(part)) return false;
  if ((part.match(/::/g) ?? []).length > 1) return false;
  const groups = part.split(':').filter((g) => g !== '');
  if (groups.length > 8) return false;
  return groups.every((g) => g.length <= 4);
}

/** True when `value` is an IP address or CIDR range Postgres will accept. */
export function isValidCidr(value: string): boolean {
  const [addr, prefix, ...rest] = value.split('/');
  if (rest.length > 0 || !addr) return false;

  const v4 = isIpv4(addr);
  const v6 = !v4 && isIpv6(addr);
  if (!v4 && !v6) return false;

  if (prefix === undefined) return true; // bare address: /32 or /128 implied
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return v4 ? bits <= 32 : bits <= 128;
}

/**
 * Normalises a bare address to an explicit single-host range, so what gets
 * stored says exactly what it means. Anything already carrying a prefix is
 * returned untouched.
 */
export function normalizeCidr(value: string): string {
  if (value.includes('/')) return value;
  return value.includes(':') ? `${value}/128` : `${value}/32`;
}
