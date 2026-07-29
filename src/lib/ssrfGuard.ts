import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Address filtering for outbound requests to customer-supplied URLs.
 *
 * Outgoing webhooks let a customer name a URL that our backend then fetches.
 * That is a server-side request forgery primitive pointed at one of the worst
 * possible networks: this process sits on the WireGuard mesh and can reach every
 * agent's Docker API directly and unauthenticated (see the container-list
 * endpoint in routes/environments.ts, which dials a guest's dockerd over the tap
 * link). A webhook URL of http://10.x.x.x:2375/containers/json would hand a
 * customer the Docker socket of a machine running other customers' VMs. The
 * loopback interface is no better: the backend's own admin surface and the
 * Postgres port live there.
 *
 * So the rule is: resolve, and refuse anything that is not a public unicast
 * address.
 *
 * The subtlety is *when* the check happens. Resolving the hostname, validating
 * the answer, and then calling fetch() re-resolves — a DNS server the attacker
 * controls can return a public address for our check and a private one for the
 * real connection, seconds apart. That is DNS rebinding, and a check-then-fetch
 * implementation is fully vulnerable to it.
 *
 * The fix is to make the validated address *be* the one connected to. Node's
 * http/https request options take a `lookup` function, which the socket calls to
 * get the address it will actually dial. Doing the filtering inside that
 * callback closes the window entirely: there is no second resolution.
 *
 * Redirects are the other half of the same hole — a perfectly public URL can 302
 * to 169.254.169.254 — and are handled by the caller simply never following
 * them (node:https doesn't, unlike fetch).
 */

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** Ranges that must never be reachable from a customer-controlled URL. Beyond
 *  the obvious private ones: 169.254/16 is where cloud metadata services live
 *  (the classic credential-theft target), 100.64/10 is carrier NAT, and the
 *  documentation/benchmark ranges are blocked because a host answering on one
 *  is by definition not the public internet. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // RFC1918
  ['100.64.0.0', 10],      // CGNAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local — cloud metadata
  ['172.16.0.0', 12],      // RFC1918
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // RFC1918
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved, incl. 255.255.255.255
];

const BLOCKED_V4_MASKS = BLOCKED_V4.map(([base, bits]) => {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) throw new Error(`bad blocklist entry ${base}`);
  // >>> 0 keeps the mask unsigned; a /0 would shift by 32 (undefined in JS), but
  // no entry uses one.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: baseInt >>> 0, mask };
});

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable — refuse rather than guess
  const v = value >>> 0;
  return BLOCKED_V4_MASKS.some(({ base, mask }) => (v & mask) >>> 0 === base);
}

/** Expands an IPv6 literal (including "::" elision and a trailing embedded IPv4)
 *  to its 16 bytes. Returns null if it isn't parseable. */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let text = ip.split('%')[0]; // strip any zone index
  const bytes = new Uint8Array(16);

  // A trailing dotted-quad ("::ffff:192.0.2.1") becomes two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tailGroups = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tailGroups.length > 8) return null;

  const write = (groups: string[], offset: number): boolean => {
    for (let i = 0; i < groups.length; i++) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return false;
      const n = parseInt(groups[i], 16);
      bytes[offset + i * 2] = (n >> 8) & 0xff;
      bytes[offset + i * 2 + 1] = n & 0xff;
    }
    return true;
  };
  if (!write(head, 0)) return null;
  if (!write(tailGroups, 16 - tailGroups.length * 2)) return null;
  return bytes;
}

function isBlockedV6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true;

  const allZero = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (b[i] !== 0) return false;
    return true;
  };

  // IPv4-mapped (::ffff:a.b.c.d) — the embedded v4 is what actually gets
  // dialled, so it has to face the v4 rules, not pass as "some IPv6 address".
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // Unspecified (::), loopback (::1) and the deprecated IPv4-compatible form,
  // which is another way to write a v4 address and not worth supporting.
  if (allZero(0, 12)) return true;

  if ((b[0] & 0xfe) === 0xfc) return true;                 // fc00::/7  unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true;                           // ff00::/8  multicast
  if (b[0] === 0x01 && allZero(1, 8)) return true;          // 100::/64  discard-only

  // Transition mechanisms all wrap an IPv4 address that the blocklist above
  // would otherwise never see: 64:ff9b::/96 (NAT64), 2002::/16 (6to4),
  // 2001:0::/32 (Teredo). Refusing them outright is simpler than unwrapping
  // each encoding, and no real webhook endpoint is reachable only this way.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  if (b[0] === 0x20 && b[1] === 0x02) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;

  return false;
}

/** True when `ip` is a public unicast address we're willing to connect to. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isBlockedV4(ip);
  if (family === 6) return !isBlockedV6(ip);
  return false;
}

/**
 * A `lookup` implementation for http/https request options that resolves
 * normally but refuses to hand back any non-public address.
 *
 * `allowPrivate` exists only so the delivery path can be exercised against a
 * local test server. It must never be true in production — see config's
 * webhookAllowPrivateTargets, which logs loudly when it is.
 */
export function guardedLookup(allowPrivate = false) {
  return function lookupGuarded(
    hostname: string,
    options: { family?: number; hints?: number; all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void {
    // `all: true` regardless of what the caller asked for: a hostname with both
    // a public and a private A record must not be usable by picking whichever
    // one the resolver happened to put first.
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const permitted = allowPrivate ? addresses : addresses.filter((a) => isPublicAddress(a.address));
      if (permitted.length === 0) {
        const seen = addresses.map((a) => a.address).join(', ');
        return callback(
          new BlockedAddressError(
            `refusing to connect to ${hostname}: resolves only to non-public addresses (${seen || 'none'})`,
          ),
          '', 0,
        );
      }
      if (options.all) return callback(null, permitted);
      callback(null, permitted[0].address, permitted[0].family);
    });
  };
}

/**
 * Validates a webhook URL at the moment it's saved, so a bad one is rejected
 * with a clear message instead of failing silently on every delivery.
 *
 * This is a usability check, not the security boundary — the hostname could
 * resolve differently by the time we deliver. guardedLookup is what actually
 * protects the connection.
 */
export function validateWebhookUrl(raw: string, allowInsecure = false): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'Not a valid URL.' };
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    return { error: 'Webhook URLs must use https.' };
  }
  if (url.username || url.password) {
    return { error: 'Credentials in the URL are not supported — use the signing secret instead.' };
  }
  // A literal IP skips DNS entirely, so it can be judged right here. Note the
  // bracket strip: URL.hostname keeps the brackets on an IPv6 literal
  // ("[::1]"), and isIP("[::1]") is 0 — so without this, every bracketed
  // address silently failed the "is it an IP" test and sailed past the check.
  const literal = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (isIP(literal) && !allowInsecure && !isPublicAddress(literal)) {
    return { error: 'That address is not routable on the public internet.' };
  }
  return { url };
}
