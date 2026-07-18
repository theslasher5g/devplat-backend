
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
    // Must clear the agent's own handler timeout (45s — see devplat-agent's
    // server.go) with margin, or this side gives up and aborts a request
    // that would've succeeded a few seconds later on the agent.
    const res = await agentFetch<{ vm_id: string; docker_endpoint: string }>(
      this.endpoint, this.token, '/vms',
      { method: 'POST', body: { team_id: teamId, ttl_minutes: ttlMinutes, vcpu, ram_mb: ramMb }, timeoutMs: 60_000 },
    );
    return { vmId: res.vm_id, dockerEndpoint: res.docker_endpoint };
  }

  async deleteVm(vmId: string): Promise<void> {
    await agentFetch(this.endpoint, this.token, `/vms/${encodeURIComponent(vmId)}`, { method: 'DELETE', timeoutMs: 15_000 });
  }

  async health(): Promise<AgentHealth> {
    const res = await agentFetch<{
      cpu_total: number; cpu_used: number; ram_total_mb: number; ram_used_mb: number;
      active_vm_count: number; draining: boolean;
    }>(this.endpoint, this.token, '/health', { timeoutMs: 5000 });
    return {
      cpuTotal: res.cpu_total, cpuUsed: res.cpu_used,
      ramTotalMb: res.ram_total_mb, ramUsedMb: res.ram_used_mb,
      activeVmCount: res.active_vm_count, draining: res.draining,
    };
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
