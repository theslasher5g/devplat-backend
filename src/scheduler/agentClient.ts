import { config } from '../config.js';

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

  async createVm(teamId: string, ttlMinutes: number): Promise<AgentVm> {
    const res = await agentFetch<{ vm_id: string; docker_endpoint: string }>(
      this.endpoint, this.token, '/vms',
      { method: 'POST', body: { team_id: teamId, ttl_minutes: ttlMinutes }, timeoutMs: 30_000 },
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

/** Free VM slots on a host given devplat's per-VM sizing (config.vmVcpus/vmRamMb). */
export function freeSlots(host: { cpu_total: number; cpu_used: number; ram_total_mb: number; ram_used_mb: number }): number {
  const freeCpuSlots = Math.floor((host.cpu_total - host.cpu_used) / config.vmVcpus);
  const freeRamSlots = Math.floor((host.ram_total_mb - host.ram_used_mb) / config.vmRamMb);
  return Math.max(0, Math.min(freeCpuSlots, freeRamSlots));
}
