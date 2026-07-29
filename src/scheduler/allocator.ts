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

// How many times to retry placing a request whose candidate hosts all failed
// createVm before giving up and marking it terminally failed. At the 5s queue
// tick this is ~25s of trying — long enough to ride out a brief agent blip,
// short enough that a genuinely un-startable request fails fast (and records a
// single failure) instead of retrying forever.
const MAX_ASSIGN_ATTEMPTS = 5;

/** Advisory-lock namespace for per-team slot reservation. Distinct from the
 *  scheduler-loop namespace in lib/advisoryLock.ts so the two can never
 *  collide on a key. */
const SLOT_LOCK_NAMESPACE = 1_684_957_100;

/**
 * Atomically claim a parallelism slot for `requestId`, or report there's none.
 *
 * This is the fix for a real over-allocation bug. requestEnvironment() used to
 * count running environments, compare against the plan cap, and only then call
 * tryAssign — with a createVm() taking seconds in between. Every concurrent
 * request read the same pre-assignment count and every one of them passed the
 * check. Reproduced against Postgres: five simultaneous requests against a
 * two-environment plan all got assigned. The trigger isn't exotic — a CI matrix
 * starting four jobs at once is the product's normal usage — and parallelism is
 * exactly what customers pay for, so the cap leaking is a billing problem, not
 * just a capacity one.
 *
 * The count and the claim now happen together under a per-team advisory lock,
 * so concurrent callers serialise on exactly this decision. The lock is
 * transaction-scoped and released at COMMIT, well before createVm() runs —
 * booting VMs stays parallel, only the bookkeeping is serialised.
 */
export async function reserveSlot(teamId: string, requestId: string, parallelEnvs: number): Promise<boolean> {
  return withTransaction(async (tx) => {
    // hashtext() maps the uuid to the int the advisory-lock API wants. A hash
    // collision between two teams would only mean they briefly queue behind
    // each other here, never a wrong decision.
    await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SLOT_LOCK_NAMESPACE, teamId]);

    const used = await tx.query<{ count: string }>(
      "SELECT count(*) FROM environment_requests WHERE team_id = $1 AND status IN ('assigned', 'assigning')",
      [teamId],
    );
    if (Number(used.rows[0].count) >= parallelEnvs) return false;

    // Claiming inside the lock is what makes the count above trustworthy for
    // the next caller: they'll see this row as 'assigning' and count it.
    const claimed = await tx.query<{ id: string }>(
      "UPDATE environment_requests SET status = 'assigning', claimed_at = now() WHERE id = $1 AND status = 'queued' RETURNING id",
      [requestId],
    );
    return (claimed.rowCount ?? 0) === 1;
  });
}

export interface EffectivePlan {
  /** Parallel-environment cap for this team right now (0 if the trial lapsed). */
  parallelEnvs: number;
  /** Per-environment resource cap the scheduler enforces on the microVM. */
  vcpu: number;
  ramMb: number;
}

/** A team's current plan caps, with the free-trial-expiry rule applied. Uses
 *  the entitlement tier — a manual plan_override if set, else the billing
 *  plan_tier — so an admin can grant capacity without a Stripe subscription. */
export async function effectivePlan(teamId: string): Promise<EffectivePlan> {
  const team = await one<{ plan_tier: PlanTier; trial_ends_at: string }>(
    'SELECT COALESCE(plan_override, plan_tier) AS plan_tier, trial_ends_at FROM teams WHERE id = $1', [teamId],
  );
  const plan = getPlan(team.plan_tier);
  const trialExpired = team.plan_tier === 'free' && new Date(team.trial_ends_at) < new Date();
  return { parallelEnvs: trialExpired ? 0 : plan.parallelEnvs, vcpu: plan.vcpuPerEnv, ramMb: plan.ramMbPerEnv };
}

/** Hosts that can fit a VM of the given size, most-free-CPU first. Excludes
 *  hosts an admin has marked to drain (they keep their existing VMs but take
 *  no new ones). */
async function candidateHosts(vcpu: number, ramMb: number): Promise<HostRow[]> {
  const res = await query<HostRow>(
    `SELECT id, name, agent_endpoint, agent_token, cpu_total, cpu_used, ram_total_mb, ram_used_mb, status
     FROM hosts WHERE status = 'online' AND drain = false AND agent_endpoint IS NOT NULL AND agent_token IS NOT NULL`,
  );
  return res.rows
    .filter((h) => hostFits(h, vcpu, ramMb))
    .sort((a, b) => hostFreeCpu(b) - hostFreeCpu(a) || a.name.localeCompare(b.name));
}

/** Try to place a queued request on the best available host. Tries hosts in
 *  least-loaded order; a single unreachable agent doesn't fail the request,
 *  it just moves to the next candidate. Returns false if nothing changed
 *  (no capacity, or every reachable host failed) so the caller/queue worker
 *  can leave it queued.
 *
 *  `logIfNoCapacity` controls whether a "no host fits" outcome is logged.
 *  Only the initial call from requestEnvironment() passes true — the queue
 *  worker retries every queued row on every tick (a few seconds), so logging
 *  there too would spam the log for as long as the request sits queued. A
 *  request that's queued for lack of *parallelism* (not size) never reaches
 *  here at all (see requestEnvironment/processQueue's running>=limit check),
 *  so this only fires for the "no single host has room" case — previously
 *  completely silent, which made a request that stays queued forever
 *  (e.g. after a plan/plan-override change asks for a bigger per-VM size
 *  than any host has free) impossible to diagnose from the logs. */
export async function tryAssign(
  requestId: string, teamId: string, plan: EffectivePlan, logIfNoCapacity = false,
): Promise<EnvironmentResult | null> {
  const { vcpu, ramMb, parallelEnvs } = plan;

  // Reserve the parallelism slot FIRST, before looking at hosts. Doing it in
  // this order means a team at its cap never even inspects host capacity, and
  // — more importantly — the claim that stops a concurrent request from
  // double-booking happens before anything slow.
  //
  // Claiming the row also solves a second, older problem: createVm() boots a
  // real VM and waits for its guest dockerd, which can still be in flight on
  // the next queue-worker tick. Without a claim, that tick's own
  // `WHERE status = 'queued'` would see this row untouched and start a
  // second, independent tryAssign for it — each booting its own VM, with only
  // the last UPDATE remembered and every earlier VM silently orphaned.
  if (!(await reserveSlot(teamId, requestId, parallelEnvs))) return null;

  const hosts = await candidateHosts(vcpu, ramMb);
  if (hosts.length === 0) {
    if (logIfNoCapacity) {
      console.warn(
        `[scheduler] no host has room for request ${requestId} (team ${teamId}, ${vcpu} vCPU / ${ramMb} MB) — ` +
        'will retry as capacity frees up; check /admin Hosts for online status and free CPU/RAM.',
      );
    }
    // Give the slot back — holding it while no host can serve it would count
    // against the team's cap for nothing.
    await query("UPDATE environment_requests SET status = 'queued', claimed_at = NULL WHERE id = $1 AND status = 'assigning'", [requestId]);
    return null;
  }

  let lastError = '';
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
      lastError = `${message}${rootCause ? ` (${rootCause})` : ''}`;
      // eslint-disable-next-line no-console
      console.warn(`[scheduler] createVm failed on host ${host.name}: ${lastError}`);
      // fall through to the next candidate host. NOTE: no start_failed event
      // is recorded per-host/per-attempt anymore — that's what caused a single
      // un-startable VM to log thousands of failures across retries. Failure is
      // recorded exactly once, below, only when we finally give up.
    }
  }

  // Every reachable candidate host failed to create a VM this round. Count the
  // attempt; keep retrying (re-queue) up to a cap, then fail the request
  // terminally and record ONE start_failed for the stats.
  const bumped = await one<{ attempts: number }>(
    "UPDATE environment_requests SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts",
    [requestId],
  );
  if (bumped.attempts >= MAX_ASSIGN_ATTEMPTS) {
    const error = `could not start a VM after ${bumped.attempts} attempts${lastError ? `: ${lastError}` : ''}`;
    await query(
      "UPDATE environment_requests SET status = 'failed', error = $2 WHERE id = $1 AND status = 'assigning'",
      [requestId, error],
    );
    await query("INSERT INTO usage_events (team_id, event_type) VALUES ($1, 'start_failed')", [teamId]);
    return { requestId, status: 'failed', error };
  }
  // Not given up yet — release the claim so the queue worker retries it.
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
export async function requestEnvironment(teamId: string, tokenId: string | null = null): Promise<EnvironmentResult> {
  const request = await one<{ id: string }>(
    "INSERT INTO environment_requests (team_id, status, token_id) VALUES ($1, 'queued', $2) RETURNING id",
    [teamId, tokenId],
  );

  // No pre-check here any more: reserveSlot inside tryAssign does the count
  // and the claim together under a per-team lock, so a check out here would be
  // both redundant and — being unsynchronised — the very thing that let the
  // cap leak. tryAssign simply returns null when there's no slot.
  const plan = await effectivePlan(teamId);
  const result = await tryAssign(request.id, teamId, plan, true);
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
