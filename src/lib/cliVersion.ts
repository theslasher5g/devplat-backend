// Server-side lookup of the latest CLI release from the release host's
// version.txt. The browser can't read get.devplat.ch/version.txt directly
// (it's a separate static host that doesn't send CORS headers), so the API
// fetches it here — a server-to-server request isn't subject to browser CORS —
// and the frontend reads it same-origin via GET /cli/latest-version.

const FALLBACK_VERSION = 'v1.1.0';
const TTL_MS = 5 * 60_000; // re-check the release host at most every 5 minutes.

let cache: { value: string; fetchedAt: number } | null = null;
let inflight: Promise<string> | null = null;

async function fetchLatest(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://get.devplat.ch/version.txt', {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`version.txt ${res.status}`);
    const trimmed = (await res.text()).trim();
    // Only accept a bare semver (optionally v-prefixed); normalise to the
    // v-prefixed form the release paths use. Anything else is treated as a
    // failure so junk never propagates to clients.
    if (!/^v?\d+\.\d+\.\d+$/.test(trimmed)) throw new Error('malformed version.txt');
    return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Latest CLI version, cached for TTL_MS. Never throws: on a failed lookup it
 *  returns the last good value, or the shipped fallback if we've never had one.
 *  Concurrent callers during a refresh share one in-flight request. */
export async function getLatestCliVersion(): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = fetchLatest()
    .then((value) => {
      cache = { value, fetchedAt: Date.now() };
      return value;
    })
    .catch(() => {
      // Keep serving the last known good value; only fall back if we have none.
      if (cache) {
        cache.fetchedAt = Date.now(); // back off; don't hammer a failing host.
        return cache.value;
      }
      return FALLBACK_VERSION;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
