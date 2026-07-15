import { PLAN_LIMITS, config, type PlanTier } from '../config.js';
import { maybeOne, one, query, withTransaction } from '../db.js';
import { AgentError, clientForHost, freeSlots } from './agentClient.js';

export interface HostRow {
  id: string; name: string; agent_endpoint: string | null; agent_token: string | null;
  cpu_total: number; cpu_used: number; ram_total_mb: number; ram_used_mb: number; status: string;
}

export interface EnvironmentResult {
  requestId: string;
  status: 'assigned' | 'queued' | 'failed';
  hostId?: string;
  vmId?: string;
  dockerEndpoint?: string;
  error?: string;
}

const DEFAULT_TTL_MINUTES = 60;

/** Requests currently occupying a slot for a team — matches the assigned rows
 *  1:1 with a running usage_events(start) that has no usage_events(stop) yet. */
async function runningCount(teamId: string): Promise<number> {
  const row = await one<{ count: string }>(
    "SELECT count(*) FROM environment_requests WHERE team_id = $1 AND status = 'assigned'",
    [teamId],
  );
  return Number(row.count);
}

async function planLimit(teamId: string): Promise<number> {
  const team = await one<{ plan_tier: PlanTier; trial_ends_at: string }>(
    'SELECT plan_tier, trial_ends_at FROM teams WHERE id = $1', [teamId],
  );
  const trialExpired = team.plan_tier === 'free' && new Date(team.trial_ends_at) < new Date();
  return trialExpired ? 0 : PLAN_LIMITS[team.plan_tier].parallelEnvs;
}

/** Hosts with spare capacity, most-free-first (least-loaded selection). */
async function candidateHosts(): Promise<HostRow[]> {
  const res = await query<HostRow>(
    `SELECT id, name, agent_endpoint, agent_token, cpu_total, cpu_used, ram_total_mb, ram_used_mb, status
     FROM hosts WHERE status = 'online' AND agent_endpoint IS NOT NULL AND agent_token IS NOT NULL`,
  );
  return res.rows
    .filter((h) => freeSlots(h) > 0)
    .sort((a, b) => freeSlots(b) - freeSlots(a) || a.name.localeCompare(b.name));
}

/** Try to place a queued request on the best available host. Tries hosts in
 *  least-loaded order; a single unreachable agent doesn't fail the request,
 *  it just moves to the next candidate. Returns false if nothing changed
 *  (no capacity, or every reachable host failed) so the caller/queue worker
 *  can leave it queued. */
export async function tryAssign(requestId: string, teamId: string): Promise<EnvironmentResult | null> {
  const hosts = await candidateHosts();
  if (hosts.length === 0) return null;

  for (const host of hosts) {
    const client = clientForHost(host);
    if (!client) continue;
    try {
      const vm = await client.createVm(teamId, DEFAULT_TTL_MINUTES);
      return await withTransaction(async (tx) => {
        await tx.query(
          `UPDATE environment_requests
           SET status = 'assigned', host_id = $1, vm_id = $2, docker_endpoint = $3, assigned_at = now()
           WHERE id = $4`,
          [host.id, vm.vmId, vm.dockerEndpoint, requestId],
        );
        await tx.query(
          `INSERT INTO usage_events (team_id, host_id, vm_id, event_type, docker_endpoint, request_id)
           VALUES ($1, $2, $3, 'start', $4, $5)`,
          [teamId, host.id, vm.vmId, vm.dockerEndpoint, requestId],
        );
        // Optimistic accounting — the health poller reconciles against the
        // agent's own view every few seconds, so drift is self-correcting.
        await tx.query(
          'UPDATE hosts SET cpu_used = cpu_used + $1, ram_used_mb = ram_used_mb + $2 WHERE id = $3',
          [config.vmVcpus, config.vmRamMb, host.id],
        );
        return { requestId, status: 'assigned', hostId: host.id, vmId: vm.vmId, dockerEndpoint: vm.dockerEndpoint };
      });
    } catch (err) {
      const message = err instanceof AgentError ? err.message : (err as Error).message;
      await query(
        `INSERT INTO usage_events (team_id, host_id, event_type) VALUES ($1, $2, 'start_failed')`,
        [teamId, host.id],
      );
      // eslint-disable-next-line no-console
      console.warn(`[scheduler] createVm failed on host ${host.name}: ${message}`);
      // fall through to the next candidate host
    }
  }
  return null;
}

/** Entry point for POST /environments. Always durable (a queue row exists
 *  immediately), assigns synchronously when capacity allows. */
export async function requestEnvironment(teamId: string): Promise<EnvironmentResult> {
  const request = await one<{ id: string }>(
    "INSERT INTO environment_requests (team_id, status) VALUES ($1, 'queued') RETURNING id",
    [teamId],
  );

  const [limit, running] = await Promise.all([planLimit(teamId), runningCount(teamId)]);
  if (running >= limit) {
    return { requestId: request.id, status: 'queued' };
  }

  const result = await tryAssign(request.id, teamId);
  if (result) return result;

  // Capacity existed on paper but every reachable host failed — leave it
  // queued rather than failing outright; the queue worker will retry.
  return { requestId: request.id, status: 'queued' };
}

export async function releaseEnvironment(teamId: string, requestId: string): Promise<{ ok: true } | { error: string }> {
  const request = await maybeOne<{ id: string; host_id: string; vm_id: string }>(
    "SELECT id, host_id, vm_id FROM environment_requests WHERE id = $1 AND team_id = $2 AND status = 'assigned'",
    [requestId, teamId],
  );
  if (!request) return { error: 'not_found_or_not_assigned' };

  const host = await maybeOne<HostRow>(
    'SELECT id, name, agent_endpoint, agent_token, cpu_total, cpu_used, ram_total_mb, ram_used_mb, status FROM hosts WHERE id = $1',
    [request.host_id],
  );
  const client = host ? clientForHost(host) : null;
  if (client) {
    try {
      await client.deleteVm(request.vm_id);
    } catch (err) {
      // Host might already be gone/unreachable — still release our side of
      // the accounting so the team isn't stuck permanently at their limit;
      // an orphaned VM on that host will be cleaned up by its own reaper's
      // TTL regardless of whether we hear back from it.
      console.warn(`[scheduler] deleteVm failed for ${request.vm_id}: ${(err as Error).message}`);
    }
  }

  await withTransaction(async (tx) => {
    await tx.query(
      "UPDATE environment_requests SET status = 'released', released_at = now() WHERE id = $1",
      [request.id],
    );
    await tx.query(
      `INSERT INTO usage_events (team_id, host_id, vm_id, event_type, request_id)
       VALUES ($1, $2, $3, 'stop', $4)`,
      [teamId, request.host_id, request.vm_id, request.id],
    );
    await tx.query(
      'UPDATE hosts SET cpu_used = GREATEST(0, cpu_used - $1), ram_used_mb = GREATEST(0, ram_used_mb - $2) WHERE id = $3',
      [config.vmVcpus, config.vmRamMb, request.host_id],
    );
  });
  return { ok: true };
}
