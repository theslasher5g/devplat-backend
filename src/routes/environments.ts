import type { FastifyInstance } from 'fastify';
import { maybeOne, one, query } from '../db.js';
import { DEFAULT_TTL_MINUTES, effectivePlan, releaseEnvironment, requestEnvironment } from '../scheduler/allocator.js';
import { requireApiTokenOrUser } from '../plugins/auth.js';

function teamIdOf(req: { apiTokenTeamId?: string; membership?: { teamId: string } }): string {
  return req.apiTokenTeamId ?? req.membership!.teamId;
}

/**
 * Environment (microVM) lifecycle for CI/local runs — this is the endpoint
 * the not-yet-built client CLI (build step 3) will call with a `dvp_ci_…`
 * API token. Requests are always durable (see scheduler/allocator.ts): a row
 * exists immediately whether or not a host was free, so callers can poll
 * GET /environments/:id instead of holding a long-lived connection open.
 */
export default async function environmentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/environments', { preHandler: requireApiTokenOrUser }, async (req, reply) => {
    const teamId = teamIdOf(req);
    const result = await requestEnvironment(teamId);
    return reply.code(result.status === 'failed' ? 502 : 202).send(result);
  });

  app.get('/environments/:id', { preHandler: requireApiTokenOrUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const teamId = teamIdOf(req);
    const row = await maybeOne<{
      id: string; status: string; host_id: string | null; vm_id: string | null;
      docker_endpoint: string | null; error: string | null; requested_at: string; assigned_at: string | null;
      vcpu: number | null; ram_mb: number | null; host_name: string | null; region: string | null;
    }>(
      `SELECT er.id, er.status, er.host_id, er.vm_id, er.docker_endpoint, er.error,
              er.requested_at, er.assigned_at, er.vcpu, er.ram_mb,
              h.name AS host_name, h.location AS region
       FROM environment_requests er
       LEFT JOIN hosts h ON h.id = er.host_id
       WHERE er.id = $1 AND er.team_id = $2`,
      [id, teamId],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });

    // The client HUD wants the team's parallel usage and this env's TTL clock.
    // TTL isn't stored per-request (the agent applies DEFAULT_TTL_MINUTES), so
    // expiresAt is assigned_at + that default — labeled as such client-side.
    const [plan, running] = await Promise.all([
      effectivePlan(teamId),
      one<{ count: string }>("SELECT count(*) FROM environment_requests WHERE team_id = $1 AND status = 'assigned'", [teamId]),
    ]);
    const expiresAt = row.assigned_at
      ? new Date(new Date(row.assigned_at).getTime() + DEFAULT_TTL_MINUTES * 60_000).toISOString()
      : null;
    return {
      requestId: row.id,
      status: row.status,
      hostId: row.host_id,
      vmId: row.vm_id,
      dockerEndpoint: row.docker_endpoint,
      error: row.error,
      requestedAt: row.requested_at,
      assignedAt: row.assigned_at,
      vcpu: row.vcpu,
      ramMb: row.ram_mb,
      region: row.region,
      hostName: row.host_name,
      expiresAt,
      ttlMinutes: DEFAULT_TTL_MINUTES,
      usage: { running: Number(running.count), limit: plan.parallelEnvs },
    };
  });

  app.get('/environments', { preHandler: requireApiTokenOrUser }, async (req) => {
    const teamId = teamIdOf(req);
    const res = await query<{
      id: string; status: string; vm_id: string | null; docker_endpoint: string | null; requested_at: string;
    }>(
      `SELECT id, status, vm_id, docker_endpoint, requested_at FROM environment_requests
       WHERE team_id = $1 AND status IN ('queued', 'assigned') ORDER BY requested_at DESC`,
      [teamId],
    );
    return {
      environments: res.rows.map((r) => ({
        requestId: r.id, status: r.status, vmId: r.vm_id, dockerEndpoint: r.docker_endpoint, requestedAt: r.requested_at,
      })),
    };
  });

  // Past runs (released or failed) for the dashboard's environment history —
  // the live /environments list only shows queued/assigned. Duration is the
  // assigned→released span (null while it never got assigned, e.g. a failure).
  app.get('/environments/history', { preHandler: requireApiTokenOrUser }, async (req) => {
    const teamId = teamIdOf(req);
    const res = await query<{
      id: string; status: string; vm_id: string | null; error: string | null;
      requested_at: string; assigned_at: string | null; released_at: string | null;
      host_name: string | null; region: string | null; duration_seconds: number | null;
    }>(
      `SELECT er.id, er.status, er.vm_id, er.error, er.requested_at, er.assigned_at, er.released_at,
              h.name AS host_name, h.location AS region,
              CASE WHEN er.assigned_at IS NOT NULL
                   THEN EXTRACT(EPOCH FROM (COALESCE(er.released_at, now()) - er.assigned_at))::int
                   END AS duration_seconds
       FROM environment_requests er LEFT JOIN hosts h ON h.id = er.host_id
       WHERE er.team_id = $1 AND er.status IN ('released', 'failed')
       ORDER BY er.requested_at DESC LIMIT 30`,
      [teamId],
    );
    return {
      runs: res.rows.map((r) => ({
        requestId: r.id, status: r.status, vmId: r.vm_id, error: r.error,
        requestedAt: r.requested_at, assignedAt: r.assigned_at, releasedAt: r.released_at,
        hostName: r.host_name, region: r.region, durationSeconds: r.duration_seconds,
      })),
    };
  });

  // Team-scoped daily VM-start activity for the dashboard usage chart. Same
  // gap-free generate_series shape as the admin timeseries, but only this
  // team's starts + failed starts.
  app.get('/environments/usage', { preHandler: requireApiTokenOrUser }, async (req) => {
    const teamId = teamIdOf(req);
    const raw = Number((req.query as { days?: string }).days ?? 14);
    const days = Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.trunc(raw))) : 14;
    const res = await query<{ day: string; starts: string; failures: string }>(
      `WITH d AS (
         SELECT generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
                                date_trunc('day', now()), interval '1 day') AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM usage_events ue WHERE ue.team_id = $2 AND ue.event_type = 'start'
                 AND ue.occurred_at >= d.day AND ue.occurred_at < d.day + interval '1 day') AS starts,
              (SELECT count(*) FROM usage_events ue WHERE ue.team_id = $2 AND ue.event_type = 'start_failed'
                 AND ue.occurred_at >= d.day AND ue.occurred_at < d.day + interval '1 day') AS failures
       FROM d ORDER BY d.day`,
      [days, teamId],
    );
    return { days: res.rows.map((r) => ({ date: r.day, starts: Number(r.starts), failures: Number(r.failures) })) };
  });

  app.delete('/environments/:id', { preHandler: requireApiTokenOrUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const teamId = teamIdOf(req);
    const result = await releaseEnvironment(teamId, id);
    if ('error' in result) return reply.code(404).send(result);
    return result;
  });
}
