import { type PlanTier } from '../config.js';
import { maybeOne, one, query, withTransaction } from '../db.js';
import { getPlan } from '../plans.js';
import { AgentError, clientForHost, hostFits, hostFreeCpu } from './agentClient.js';

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

export const DEFAULT_TTL_MINUTES = 60;

/** Requests currently occupying a slot for a team — matches the assigned rows
 *  1:1 with a running usage_events(start) that has no usage_events(stop) yet. */
async function runningCount(teamId: string): Promise<number> {
  const row = await one<{ count: string }>(
    "SELECT count(*) FROM environment_requests WHERE team_id = $1 AND status = 'assigned'",
    [teamId],
  );
  return Number(row.count);
}

export interface EffectivePlan {
  /** Parallel-environment cap for this team right now (0 if the trial lapsed). */
  parallelEnvs: number;
  /** Per-environment resource cap the scheduler enforces on the microVM. */
  vcpu: number;
  ramMb: number;
}

/** A team's current plan caps, with the free-trial-expiry rule applied. */
export async function effectivePlan(teamId: string): Promise<EffectivePlan> {
  const team = await one<{ plan_tier: PlanTier; trial_ends_at: string }>(
    'SELECT plan_tier, trial_ends_at FROM teams WHERE id = $1', [teamId],
  );
  const plan = getPlan(team.plan_tier);
  const trialExpired = team.plan_tier === 'free' && new Date(team.trial_ends_at) < new Date();
  return { parallelEnvs: trialExpired ? 0 : plan.parallelEnvs, vcpu: plan.vcpuPerEnv, ramMb: plan.ramMbPerEnv };
}

/** Hosts that can fit a VM of the given size, most-free-CPU first. */
async function candidateHosts(vcpu: number, ramMb: number): Promise<HostRow[]> {
  const res = await query<HostRow>(
    `SELECT id, name, agent_endpoint, agent_token, cpu_total, cpu_used, ram_total_mb, ram_used_mb, status
     FROM hosts WHERE status = 'online' AND agent_endpoint IS NOT NULL AND agent_token IS NOT NULL`,
  );
  return res.rows
    .filter((h) => hostFits(h, vcpu, ramMb))
    .sort((a, b) => hostFreeCpu(b) - hostFreeCpu(a) || a.name.localeCompare(b.name));
}

/** Try to place a queued request on the best available host. Tries hosts in
 *  least-loaded order; a single unreachable agent doesn't fail the request,
 *  it just moves to the next candidate. Returns false if nothing changed
 *  (no capacity, or every reachable host failed) so the caller/queue worker
 *  can leave it queued. */
export async function tryAssign(requestId: string, teamId: string, vcpu: number, ramMb: number): Promise<EnvironmentResult | null> {
  const hosts = await candidateHosts(vcpu, ramMb);
  if (hosts.length === 0) return null;

  // Claim the row before doing anything slow. createVm() boots a real VM and
  // waits for its guest dockerd to become reachable — that can take several
  // seconds, long enough to still be in flight on the next queue-worker tick
  // (see queueWorker.ts, ticking every few seconds). Without a claim, that
  // next tick's own SELECT ... WHERE status = 'queued' would see this same
  // row untouched and start a second, fully independent tryAssign() for it —
  // each one booting its own VM. Only the last UPDATE below would ever be
  // remembered, silently orphaning every earlier VM as a permanently
  // running, permanently untracked resource leak. This was masked as long
  // as createVm() was slow enough to reliably blow past every timeout layer
  // (it just failed instead of racing) — fixing that unmasked this bug.
  const claimed = await maybeOne<{ id: string }>(
    "UPDATE environment_requests SET status = 'assigning', claimed_at = now() WHERE id = $1 AND status = 'queued' RETURNING id",
    [requestId],
  );
  if (!claimed) return null; // already claimed by a concurrent attempt

  for (const host of hosts) {
    const client = clientForHost(host);
    if (!client) continue;
    try {
      const vm = await client.createVm(teamId, DEFAULT_TTL_MINUTES, vcpu, ramMb);
      const assignedRow = await maybeOne<{ id: string }>(
        `UPDATE environment_requests
         SET status = 'assigned', host_id = $1, vm_id = $2, docker_endpoint = $3,
             vcpu = $4, ram_mb = $5, assigned_at = now()
         WHERE id = $6 AND status = 'assigning'
         RETURNING id`,
        [host.id, vm.vmId, vm.dockerEndpoint, vcpu, ramMb, requestId],
      );
      if (!assignedRow) {
        // Released (or otherwise moved on) while createVm() was in flight —
        // nobody's going to ask for this VM, don't leak it.
        try {
          await client.deleteVm(vm.vmId);
        } catch (err) {
          console.warn(`[scheduler] cleanup deleteVm failed for orphaned ${vm.vmId}: ${(err as Error).message}`);
        }
        return null;
      }
      await withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO usage_events (team_id, host_id, vm_id, event_type, docker_endpoint, request_id)
           VALUES ($1, $2, $3, 'start', $4, $5)`,
          [teamId, host.id, vm.vmId, vm.dockerEndpoint, requestId],
        );
        // Optimistic accounting with this VM's actual (plan-derived) size —
        // the health poller reconciles against the agent's own view every few
        // seconds, so drift is self-correcting.
        await tx.query(
          'UPDATE hosts SET cpu_used = cpu_used + $1, ram_used_mb = ram_used_mb + $2 WHERE id = $3',
          [vcpu, ramMb, host.id],
        );
      });
      return { requestId, status: 'assigned', hostId: host.id, vmId: vm.vmId, dockerEndpoint: vm.dockerEndpoint };
    } catch (err) {
      const message = err instanceof AgentError ? err.message : (err as Error).message;
      // fetch()'s own errors (undici) nest the actual OS-level cause
      // (ECONNREFUSED, ENOTFOUND, ...) two levels down and Node doesn't
      // print it by default — "fetch failed" alone isn't enough to debug a
      // host that's unreachable, so surface the real cause explicitly.
      const cause = err instanceof AgentError ? err.cause : undefined;
      const rootCause = cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : undefined;
      await query(
        `INSERT INTO usage_events (team_id, host_id, event_type) VALUES ($1, $2, 'start_failed')`,
        [teamId, host.id],
      );
      // eslint-disable-next-line no-console
      console.warn(`[scheduler] createVm failed on host ${host.name}: ${message}${rootCause ? ` (${rootCause})` : ''}`);
      // fall through to the next candidate host
    }
  }
  // Every reachable host failed — release the claim so the queue worker
  // picks this row up again on a later tick instead of it being stuck in
  // 'assigning' forever.
  await query("UPDATE environment_requests SET status = 'queued' WHERE id = $1 AND status = 'assigning'", [requestId]);
  return null;
}

/** Revert any 'assigning' claim that's been sitting for too long back to
 *  'queued' so the worker retries it. tryAssign()'s own revert-on-failure
 *  only runs if that same process lives long enough to reach it — a crash
 *  or restart (deploy, OOM, anything) mid-claim leaves nothing to run that
 *  code, and since the queue worker only ever looks at 'queued' rows, an
 *  un-reverted 'assigning' row would otherwise sit stuck forever. Any claim
 *  genuinely still in flight is far shorter-lived than this threshold (the
 *  agent's own createVm budget tops out well under a minute per host). */
export async function reclaimStaleAssignments(staleAfterMs = 3 * 60_000): Promise<void> {
  await query(
    `UPDATE environment_requests SET status = 'queued', claimed_at = NULL
     WHERE status = 'assigning' AND claimed_at < now() - ($1 || ' milliseconds')::interval`,
    [staleAfterMs],
  );
}

/** Entry point for POST /environments. Always durable (a queue row exists
 *  immediately), assigns synchronously when capacity allows. */
export async function requestEnvironment(teamId: string): Promise<EnvironmentResult> {
  const request = await one<{ id: string }>(
    "INSERT INTO environment_requests (team_id, status) VALUES ($1, 'queued') RETURNING id",
    [teamId],
  );

  const [plan, running] = await Promise.all([effectivePlan(teamId), runningCount(teamId)]);
  if (running >= plan.parallelEnvs) {
    return { requestId: request.id, status: 'queued' };
  }

  const result = await tryAssign(request.id, teamId, plan.vcpu, plan.ramMb);
  if (result) return result;

  // Capacity existed on paper but every reachable host failed — leave it
  // queued rather than failing outright; the queue worker will retry.
  return { requestId: request.id, status: 'queued' };
}

export async function releaseEnvironment(teamId: string, requestId: string): Promise<{ ok: true } | { error: string }> {
  // A request stuck in 'queued' (e.g. every candidate host was
  // unreachable) never got a VM or host accounting — there's nothing to
  // tear down, just stop the queue worker from retrying it. Conditioned
  // on status = 'queued' in the UPDATE itself so a concurrent assignment
  // (queue worker wins the race) can't get silently discarded here; if
  // that happens this affects 0 rows and falls through to the normal
  // assigned-release path below.
  const releasedQueued = await maybeOne<{ id: string }>(
    "UPDATE environment_requests SET status = 'released', released_at = now() WHERE id = $1 AND team_id = $2 AND status IN ('queued', 'assigning') RETURNING id",
    [requestId, teamId],
  );
  if (releasedQueued) return { ok: true };

  const request = await maybeOne<{ id: string; host_id: string; vm_id: string; vcpu: number | null; ram_mb: number | null }>(
    "SELECT id, host_id, vm_id, vcpu, ram_mb FROM environment_requests WHERE id = $1 AND team_id = $2 AND status = 'assigned'",
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
    // Subtract exactly what assignment added (stored on the request row); the
    // health poller reconciles against the agent's own view regardless.
    await tx.query(
      'UPDATE hosts SET cpu_used = GREATEST(0, cpu_used - $1), ram_used_mb = GREATEST(0, ram_used_mb - $2) WHERE id = $3',
      [request.vcpu ?? 0, request.ram_mb ?? 0, request.host_id],
    );
  });
  return { ok: true };
}
