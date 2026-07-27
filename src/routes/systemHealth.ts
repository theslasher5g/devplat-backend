import { promises as fs } from 'node:fs';
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { one, query } from '../db.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

/**
 * Control-plane host and database health for the admin dashboard.
 *
 * The existing /admin/hosts view covers the Firecracker data plane; this covers
 * the VPS the API and Postgres themselves run on, which had no visibility at
 * all — the first sign of a saturated control plane would otherwise be users
 * reporting that the dashboard feels slow.
 */

/** CPU usage sampled over a short window. os.loadavg() is 1-minute-smoothed and
 *  needs core-count context to read, so measure actual busy vs idle jiffies. */
function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return { idle, total };
}

async function cpuUsagePercent(sampleMs = 200): Promise<number> {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = cpuTimes();
  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

/**
 * Memory as the container actually sees it. os.totalmem() reports the whole
 * host, which is wrong (and reassuringly low) inside a memory-limited
 * container, so prefer the cgroup v2 values when they're present.
 */
async function memoryUsage(): Promise<{ totalBytes: number; usedBytes: number; source: string }> {
  try {
    const [maxRaw, curRaw] = await Promise.all([
      fs.readFile('/sys/fs/cgroup/memory.max', 'utf8'),
      fs.readFile('/sys/fs/cgroup/memory.current', 'utf8'),
    ]);
    const max = maxRaw.trim();
    const cur = Number(curRaw.trim());
    // "max" means no limit set — fall through to the host numbers.
    if (max !== 'max' && Number.isFinite(Number(max)) && Number.isFinite(cur)) {
      return { totalBytes: Number(max), usedBytes: cur, source: 'cgroup' };
    }
  } catch {
    // Not on cgroup v2 (or no permission) — use the host view below.
  }
  return { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem(), source: 'host' };
}

export default async function systemHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/system', { preHandler: requirePlatformAdmin }, async (req) => {
    const [cpuPercent, memory, disk, dbSize, dbActivity, dbTables, slowest] = await Promise.all([
      cpuUsagePercent(),
      memoryUsage(),
      statfs('/').then(
        (s) => ({
          totalBytes: s.blocks * s.bsize,
          // bavail (available to unprivileged users) rather than bfree, which
          // includes root-reserved blocks the app can never actually use.
          freeBytes: s.bavail * s.bsize,
        }),
        () => null,
      ),
      one<{ size: string; bytes: string }>(
        "SELECT pg_size_pretty(pg_database_size(current_database())) AS size, pg_database_size(current_database()) AS bytes",
      ),
      one<{ total: string; active: string; idle_in_tx: string; waiting: string; max_conn: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE state = 'active') AS active,
                count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx,
                count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting,
                current_setting('max_connections') AS max_conn
         FROM pg_stat_activity WHERE datname = current_database()`,
      ),
      // Cache hit ratio: how often reads were served from shared buffers rather
      // than disk. Below ~0.99 on a warm database usually means memory pressure.
      one<{ hit_ratio: string | null; commits: string; rollbacks: string; deadlocks: string }>(
        `SELECT CASE WHEN blks_hit + blks_read > 0
                     THEN blks_hit::float / (blks_hit + blks_read) END AS hit_ratio,
                xact_commit AS commits, xact_rollback AS rollbacks, deadlocks
         FROM pg_stat_database WHERE datname = current_database()`,
      ),
      // pg_stat_statements is an optional extension; treat its absence as
      // "no data" rather than failing the whole endpoint.
      query<{ query: string; calls: string; mean_ms: number; total_ms: number }>(
        `SELECT query, calls, mean_exec_time AS mean_ms, total_exec_time AS total_ms
         FROM pg_stat_statements
         WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
         ORDER BY mean_exec_time DESC LIMIT 5`,
      ).catch(() => null),
    ]);

    const load = os.loadavg();
    return {
      host: {
        cpuPercent: Number(cpuPercent.toFixed(1)),
        cpuCores: os.cpus().length,
        loadAverage: { one: load[0], five: load[1], fifteen: load[2] },
        memory: {
          totalBytes: memory.totalBytes,
          usedBytes: memory.usedBytes,
          percent: memory.totalBytes > 0 ? Number(((memory.usedBytes / memory.totalBytes) * 100).toFixed(1)) : 0,
          source: memory.source,
        },
        disk: disk && {
          totalBytes: disk.totalBytes,
          usedBytes: disk.totalBytes - disk.freeBytes,
          percent: disk.totalBytes > 0
            ? Number((((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100).toFixed(1))
            : 0,
        },
        uptimeSeconds: Math.round(os.uptime()),
        processUptimeSeconds: Math.round(process.uptime()),
      },
      database: {
        sizePretty: dbSize.size,
        sizeBytes: Number(dbSize.bytes),
        connections: {
          total: Number(dbActivity.total),
          active: Number(dbActivity.active),
          idleInTransaction: Number(dbActivity.idle_in_tx),
          waitingOnLocks: Number(dbActivity.waiting),
          max: Number(dbActivity.max_conn),
        },
        cacheHitRatio: dbTables.hit_ratio === null ? null : Number(dbTables.hit_ratio),
        commits: Number(dbTables.commits),
        rollbacks: Number(dbTables.rollbacks),
        deadlocks: Number(dbTables.deadlocks),
        // null when pg_stat_statements isn't installed — the UI says so rather
        // than showing an empty list that looks like "everything is fast".
        slowestQueries: slowest
          ? slowest.rows.map((q) => ({
              query: q.query.replace(/\s+/g, ' ').slice(0, 160),
              calls: Number(q.calls),
              meanMs: Number(q.mean_ms.toFixed(2)),
              totalMs: Number(q.total_ms.toFixed(0)),
            }))
          : null,
      },
    };
  });
}
