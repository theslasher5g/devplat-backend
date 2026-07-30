import { config } from '../config.js';
import { query } from '../db.js';
import { SchedulerLock, lockedTick } from '../lib/advisoryLock.js';
import { sendHostOfflineAlert, sendOpsAlert } from '../lib/alerts.js';
import { recordComponentStatuses } from '../lib/status.js';
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
      // counters rather than nulling them. A healthy poll also clears any open
      // offline alert, so a future outage re-alerts (see below).
      // Measured usage rides along on the same COALESCE discipline as the
      // cache counters (see migration 035): absent stays absent rather than
      // becoming a zero that would make an unmeasured host look idle.
      const u = health.usage;
      await query(
        `UPDATE hosts SET status = $1, cpu_used = $2, ram_used_mb = $3, last_heartbeat = now(),
                cache_lookups = COALESCE($4, cache_lookups), cache_hits = COALESCE($5, cache_hits),
                ram_committed_mb = COALESCE($6, ram_committed_mb),
                ram_granted_mb = COALESCE($7, ram_granted_mb),
                ram_guest_used_mb = COALESCE($8, ram_guest_used_mb),
                ram_host_available_mb = COALESCE($9, ram_host_available_mb),
                cpu_busy_pct = COALESCE($10, cpu_busy_pct),
                cpu_used_actual = COALESCE($11, cpu_used_actual),
                cpu_throttled_vms = COALESCE($12, cpu_throttled_vms),
                usage_reported_at = CASE WHEN $13 THEN now() ELSE usage_reported_at END,
                offline_alerted_at = NULL
         WHERE id = $14`,
        [health.draining ? 'draining' : 'online', health.cpuUsed, health.ramUsedMb,
          health.cacheLookups ?? null, health.cacheHits ?? null,
          u?.ramCommittedMb ?? null, u?.ramGrantedMb ?? null, u?.ramGuestUsedMb ?? null,
          u?.ramHostAvailableMb ?? null, u?.cpuBusyPct ?? null, u?.cpuUsedActual ?? null,
          u?.cpuThrottledVms ?? null, u !== undefined, host.id],
      );
    } catch {
      const staleSeconds = host.last_heartbeat
        ? (Date.now() - new Date(host.last_heartbeat).getTime()) / 1000
        : Infinity;
      if (staleSeconds > config.agentHeartbeatTimeoutSeconds) {
        // Mark offline and claim the alert atomically: the `offline_alerted_at
        // IS NULL` guard means exactly one poll tick fires the alert per outage
        // (it stays set until a healthy poll clears it), so a host that's been
        // down for an hour doesn't re-notify every 5s.
        const claimed = await query<{ name: string; location: string; last_heartbeat: string | null }>(
          `UPDATE hosts SET status = 'offline', offline_alerted_at = now()
           WHERE id = $1 AND offline_alerted_at IS NULL
           RETURNING name, location, last_heartbeat`,
          [host.id],
        );
        if (claimed.rowCount === 1) {
          const h = claimed.rows[0];
          await sendHostOfflineAlert({ name: h.name, location: h.location, lastHeartbeat: h.last_heartbeat })
            .catch((err) => console.error('[scheduler] host-offline alert failed', err));
        }
      }
    }
  }));
}

/**
 * How recently a host must have starved a guest to count as "starving now".
 *
 * The counter is cumulative, so without a recency window a host that had one
 * bad afternoon three weeks ago would keep qualifying forever.
 */
const STARVATION_RECENT_MS = 10 * 60_000;

/**
 * How long before the same host may alert again.
 *
 * Six hours, matching the error tracker's re-alert window. The tension is real
 * in both directions: alert once per episode and a host that starts starving
 * guests worse an hour later says nothing, while alerting per occurrence turns
 * one bad host into a full inbox, which is how alerts get filtered into a
 * folder and stop working entirely.
 */
const STARVATION_REALERT_MS = 6 * 3_600_000;

/**
 * Mail about hosts that could not keep the memory promises they sold.
 *
 * The counter this reads exists so an overcommit ratio set too high is visible
 * rather than inferred — but visible on a dashboard is not the same as noticed.
 * Nobody has the admin host view open at the moment a build slows down, and the
 * customer-side symptom ("it felt slower today") never arrives as a bug report.
 *
 * The claim and the selection are one statement, so several scheduler instances
 * racing here produce one mail rather than one each — the same trick as the
 * offline alert, and as the error tracker's alerted_at = now() test.
 */
export async function alertOnStarvation(): Promise<void> {
  const claimed = await query<{
    name: string; location: string; starved_grants: string; overcommit_pct: number | null;
  }>(
    `UPDATE hosts SET starvation_alerted_at = now()
     WHERE starved_grants > 0
       AND starved_grants_at > now() - ($1::int * interval '1 millisecond')
       AND (starvation_alerted_at IS NULL
            OR starvation_alerted_at < now() - ($2::int * interval '1 millisecond'))
     RETURNING name, location, starved_grants, overcommit_pct`,
    [STARVATION_RECENT_MS, STARVATION_REALERT_MS],
  );

  for (const h of claimed.rows) {
    await sendOpsAlert(
      `Host ${h.name} is starving guests of promised memory`,
      `${h.name} (${h.location}) promises ${h.overcommit_pct ?? '?'}% of its physical RAM and has now refused `
      + `memory to a guest ${h.starved_grants} time(s) — memory that customer's plan entitles them to and `
      + 'they are paying for.\n\n'
      + 'Nothing has crashed. The visible effect is builds on that host running slower than the plan promises, '
      + 'which no customer will report as a bug.\n\n'
      + `Lower RAM_OVERCOMMIT_PCT on ${h.name} and restart the agent. The admin host view shows the measured `
      + 'memory this ratio was meant to be justified by.',
      ':warning:',
    ).catch((err: unknown) => console.error('[scheduler] starvation alert failed', err));
  }
}

export function startHealthPoller(intervalMs: number): () => void {
  // Reconcile host health first, then snapshot any derived-status change into
  // the status history. Chained so the recording sees the freshly-updated
  // hosts.status. Advisory-locked so N instances don't poll every agent N
  // times per interval and write N status-history rows for one transition.
  const timer = setInterval(
    lockedTick('health poll', SchedulerLock.healthPoller, async () => {
      await pollHostHealth();
      await recordComponentStatuses();
      await alertOnStarvation();
    }),
    intervalMs,
  );
  return () => clearInterval(timer);
}
