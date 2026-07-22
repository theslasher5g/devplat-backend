import { config } from '../config.js';
import { query } from '../db.js';
import { clientForHost } from './agentClient.js';

interface HostRow {
  id: string; agent_endpoint: string | null; agent_token: string | null; last_heartbeat: string | null;
}

/** Scheduler-initiated GET /health poll — complements the agent's own push
 *  heartbeat (see routes/hosts.ts for why agents can't write Postgres
 *  directly). This is the authoritative reconciler for hosts.cpu_used /
 *  ram_used_mb: the allocator updates those optimistically at assign/release
 *  time, and a successful poll here overwrites them with the agent's actual
 *  view, so any drift (crashed agent, missed release, manual VM cleanup on
 *  the host) self-heals within one poll interval. On failure, a host is only
 *  marked offline once its last heartbeat is also stale — a single missed
 *  poll (e.g. transient network blip) shouldn't pull it out of rotation. */
export async function pollHostHealth(): Promise<void> {
  const hosts = await query<HostRow>(
    'SELECT id, agent_endpoint, agent_token, last_heartbeat FROM hosts WHERE agent_endpoint IS NOT NULL AND agent_token IS NOT NULL',
  );

  await Promise.all(hosts.rows.map(async (host) => {
    const client = clientForHost(host);
    if (!client) return;
    try {
      const health = await client.health();
      // COALESCE so a poll that couldn't read cache stats keeps the last known
      // counters rather than nulling them.
      await query(
        `UPDATE hosts SET status = $1, cpu_used = $2, ram_used_mb = $3, last_heartbeat = now(),
                cache_lookups = COALESCE($4, cache_lookups), cache_hits = COALESCE($5, cache_hits)
         WHERE id = $6`,
        [health.draining ? 'draining' : 'online', health.cpuUsed, health.ramUsedMb,
          health.cacheLookups ?? null, health.cacheHits ?? null, host.id],
      );
    } catch {
      const staleSeconds = host.last_heartbeat
        ? (Date.now() - new Date(host.last_heartbeat).getTime()) / 1000
        : Infinity;
      if (staleSeconds > config.agentHeartbeatTimeoutSeconds) {
        await query("UPDATE hosts SET status = 'offline' WHERE id = $1", [host.id]);
      }
    }
  }));
}

export function startHealthPoller(intervalMs: number): () => void {
  const timer = setInterval(() => {
    pollHostHealth().catch((err) => console.error('[scheduler] health poll tick failed', err));
  }, intervalMs);
  return () => clearInterval(timer);
}
