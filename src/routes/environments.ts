import type { FastifyInstance } from 'fastify';
import { maybeOne, query } from '../db.js';
import { releaseEnvironment, requestEnvironment } from '../scheduler/allocator.js';
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
    }>(
      `SELECT id, status, host_id, vm_id, docker_endpoint, error, requested_at, assigned_at
       FROM environment_requests WHERE id = $1 AND team_id = $2`,
      [id, teamId],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return {
      requestId: row.id,
      status: row.status,
      hostId: row.host_id,
      vmId: row.vm_id,
      dockerEndpoint: row.docker_endpoint,
      error: row.error,
      requestedAt: row.requested_at,
      assignedAt: row.assigned_at,
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

  app.delete('/environments/:id', { preHandler: requireApiTokenOrUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const teamId = teamIdOf(req);
    const result = await releaseEnvironment(teamId, id);
    if ('error' in result) return reply.code(404).send(result);
    return result;
  });
}
