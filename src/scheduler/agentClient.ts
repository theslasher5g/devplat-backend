
export interface AgentVm {
  vmId: string;
  dockerEndpoint: string;
}

export interface AgentHealth {
  cpuTotal: number;
  cpuUsed: number;
  ramTotalMb: number;
  ramUsedMb: number;
  activeVmCount: number;
  draining: boolean;
  // Cumulative registry-cache counters, undefined when the host's registry
  // debug endpoint is off/unreachable.
  cacheLookups?: number;
  cacheHits?: number;
  // Measured usage, as opposed to the committed figures above. Undefined when
  // the agent doesn't report it (an older build, or guests that haven't
  // answered yet) — which must stay distinguishable from a measured zero, or
  // an unmeasured host looks idle and attracts every VM on the fleet.
  usage?: AgentUsage;
}

/** What the hardware is actually doing, straight from the agent. */
export interface AgentUsage {
  ramCommittedMb?: number;
  ramGrantedMb?: number;
  ramGuestUsedMb?: number;
  ramHostAvailableMb?: number;
  cpuBusyPct?: number;
  cpuUsedActual?: number;
  cpuThrottledVms?: number;
}

/** Per-VM promise-vs-reality for the admin drill-down. Every measured field is
 *  optional for the same reason as above: a VM still booting has no numbers,
 *  and rendering that as zero would put a fabricated point into the sample an
 *  overcommit factor gets derived from. */
export interface AgentVmUsage {
  vmId: string;
  teamId: string;
  createdAt: string;
  expiresAt: string;
  vcpu: number;
  ramMb: number;
  balloonMb: number;
  usableMb?: number;
  usedMb?: number;
  availableMb?: number;
  cachesMb?: number;
  vcpuUsed?: number;
  throttledPct?: number;
}

export class AgentError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

async function agentFetch<T>(
  endpoint: string, token: string, path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AgentError(`agent ${path} returned ${res.status}: ${detail.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AgentError) throw err;
    throw new AgentError(`agent ${path} request failed: ${(err as Error).message}`, err);
  } finally {
    clearTimeout(timeout);
  }
}

/** Thin HTTP client for one host's devplat-agent, reached over WireGuard. */
export class AgentClient {
  constructor(private readonly endpoint: string, private readonly token: string) {}

  async createVm(teamId: string, ttlMinutes: number, vcpu: number, ramMb: number): Promise<AgentVm> {
    // Must clear the agent's own handler timeout (90s — see devplat-agent's
    // server.go) with margin, or this side gives up and aborts a request
    // that would've succeeded a few seconds later on the agent.
    const res = await agentFetch<{ vm_id: string; docker_endpoint: string }>(
      this.endpoint, this.token, '/vms',
      { method: 'POST', body: { team_id: teamId, ttl_minutes: ttlMinutes, vcpu, ram_mb: ramMb }, timeoutMs: 110_000 },
    );
    return { vmId: res.vm_id, dockerEndpoint: res.docker_endpoint };
  }

  async deleteVm(vmId: string): Promise<void> {
    await agentFetch(this.endpoint, this.token, `/vms/${encodeURIComponent(vmId)}`, { method: 'DELETE', timeoutMs: 15_000 });
  }

  async health(): Promise<AgentHealth> {
    const res = await agentFetch<{
      cpu_total: number; cpu_used: number; ram_total_mb: number; ram_used_mb: number;
      active_vm_count: number; draining: boolean; cache_lookups?: number; cache_hits?: number;
      memory?: {
        committed_mb: number; granted_mb: number; guest_used_mb: number;
        host_total_mb: number; host_available_mb: number;
      };
      cpu?: { busy_pct: number; used_vcpu: number; throttled_vms: number };
    }>(this.endpoint, this.token, '/health', { timeoutMs: 5000 });

    // The memory and cpu blocks arrive independently: host CPU is read from
    // /proc/stat and doesn't depend on any guest answering, while the memory
    // block only appears once every guest has. A host can legitimately report
    // one and not the other, so `usage` is present if either is.
    const usage: AgentUsage = {};
    if (res.memory) {
      usage.ramCommittedMb = res.memory.committed_mb;
      usage.ramGrantedMb = res.memory.granted_mb;
      usage.ramGuestUsedMb = res.memory.guest_used_mb;
      usage.ramHostAvailableMb = res.memory.host_available_mb;
    }
    if (res.cpu) {
      usage.cpuBusyPct = res.cpu.busy_pct;
      usage.cpuUsedActual = res.cpu.used_vcpu;
      usage.cpuThrottledVms = res.cpu.throttled_vms;
    }

    return {
      cpuTotal: res.cpu_total, cpuUsed: res.cpu_used,
      ramTotalMb: res.ram_total_mb, ramUsedMb: res.ram_used_mb,
      activeVmCount: res.active_vm_count, draining: res.draining,
      cacheLookups: res.cache_lookups, cacheHits: res.cache_hits,
      usage: res.memory || res.cpu ? usage : undefined,
    };
  }

  /** Live per-VM usage. Only the admin drill-down calls this — it's a
   *  round-trip to the host, so it stays out of the health poll's hot path. */
  async vms(): Promise<AgentVmUsage[]> {
    const res = await agentFetch<{
      vms: {
        vm_id: string; team_id: string; created_at: string; expires_at: string;
        vcpu: number; ram_mb: number; balloon_mb: number;
        usable_mb?: number; used_mb?: number; available_mb?: number; caches_mb?: number;
        vcpu_used?: number; throttled_pct?: number;
      }[];
    }>(this.endpoint, this.token, '/vms', { timeoutMs: 8000 });
    return res.vms.map((v) => ({
      vmId: v.vm_id, teamId: v.team_id, createdAt: v.created_at, expiresAt: v.expires_at,
      vcpu: v.vcpu, ramMb: v.ram_mb, balloonMb: v.balloon_mb,
      usableMb: v.usable_mb, usedMb: v.used_mb, availableMb: v.available_mb, cachesMb: v.caches_mb,
      vcpuUsed: v.vcpu_used, throttledPct: v.throttled_pct,
    }));
  }
}

export function clientForHost(host: { agent_endpoint: string | null; agent_token: string | null }): AgentClient | null {
  if (!host.agent_endpoint || !host.agent_token) return null;
  return new AgentClient(host.agent_endpoint, host.agent_token);
}

interface HostCapacity { cpu_total: number; cpu_used: number; ram_total_mb: number; ram_used_mb: number }

/** Raw free CPU/RAM on a host. VMs are now variable-sized (per the requesting
 *  team's plan), so capacity is tracked as raw resources, not fixed slots. */
export function hostFreeCpu(host: HostCapacity): number { return host.cpu_total - host.cpu_used; }
export function hostFreeRamMb(host: HostCapacity): number { return host.ram_total_mb - host.ram_used_mb; }

/** Whether a host has room for a VM of the given size. */
export function hostFits(host: HostCapacity, vcpu: number, ramMb: number): boolean {
  return hostFreeCpu(host) >= vcpu && hostFreeRamMb(host) >= ramMb;
}
