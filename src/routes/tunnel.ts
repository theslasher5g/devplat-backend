import http from 'node:http';
import net from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData } from 'ws';
import type { WebSocket } from 'ws';
import { maybeOne } from '../db.js';
import { requireApiTokenOrUser } from '../plugins/auth.js';

function teamIdOf(req: { apiTokenTeamId?: string; membership?: { teamId: string } }): string {
  return req.apiTokenTeamId ?? req.membership!.teamId;
}

/**
 * Raw TCP↔WebSocket relay for the CLI. Per the security model, a VM's
 * docker_endpoint only accepts connections sourced from the control plane's
 * own WireGuard subnet — the CLI runs on an arbitrary laptop/CI runner
 * outside that mesh, so it can't dial docker_endpoint directly. This process
 * IS on the mesh, so it dials on the CLI's behalf and shovels bytes both
 * ways once the WebSocket (client, over the public internet) and the raw
 * TCP socket (server-side, over WireGuard) are both up.
 *
 * Two endpoints share that relay:
 *
 * - /environments/:id/tunnel        → the VM's Docker API (docker_endpoint,
 *   the host-side DNAT to guest:2375). One WS per local Docker connection.
 * - /environments/:id/tunnel/:port  → an arbitrary port inside the guest,
 *   for Testcontainers port mapping: ports Docker publishes inside the VM
 *   are only DNAT'd guest-side, so there is no host port to dial. Instead
 *   this reaches them through the devplat-agent's per-port proxy
 *   (GET /vms/:id/proxy/:port with an HTTP Upgrade — see devplat-agent's
 *   api/server.go), which pipes to the guest IP over the tap link. The
 *   agent endpoint itself is only reachable over WireGuard, and the agent
 *   derives the guest IP strictly from the VM id, so the same team check
 *   that guards docker_endpoint guards every container port too.
 */
export default async function tunnelRoutes(app: FastifyInstance): Promise<void> {
  // relay wires one client WebSocket to one upstream TCP socket produced by
  // `connect`. The WebSocket handshake is already complete by the time a
  // handler runs — the client can start sending immediately. Everything the
  // connect callback does (DB lookup, TCP/upgrade dial) happens after that,
  // so the message listener and a buffer must be wired up synchronously,
  // before any `await`, or bytes sent in that window are silently dropped
  // (this was a real bug: worked in a slow manual test, failed reliably
  // against a fast client that writes right after connecting).
  const relay = (
    socket: WebSocket,
    req: FastifyRequest,
    connect: () => Promise<net.Socket | { close: { code: number; reason: string } }>,
  ): void => {
    const pending: Buffer[] = [];
    let tcp: net.Socket | null = null;
    let tcpReady = false;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      tcp?.destroy();
      if (socket.readyState === socket.OPEN) socket.close();
    };

    socket.on('message', (data: RawData) => {
      const buf = data as Buffer;
      if (tcpReady && tcp) tcp.write(buf);
      else pending.push(buf);
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    void (async () => {
      let upstream: net.Socket | { close: { code: number; reason: string } };
      try {
        upstream = await connect();
      } catch (err) {
        req.log.warn({ err }, 'tunnel: upstream connection failed');
        if (!closed && socket.readyState === socket.OPEN) socket.close(4502, 'upstream_unreachable');
        cleanup();
        return;
      }
      if ('close' in upstream) {
        if (!closed && socket.readyState === socket.OPEN) socket.close(upstream.close.code, upstream.close.reason);
        cleanup();
        return;
      }
      if (closed) {
        // client disconnected while we were connecting
        upstream.destroy();
        return;
      }
      tcp = upstream;
      tcpReady = true;
      for (const buf of pending) tcp.write(buf);
      pending.length = 0;

      tcp.on('data', (chunk) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk);
      });
      tcp.on('error', (err) => {
        req.log.warn({ err }, 'tunnel: upstream connection error');
        cleanup();
      });
      tcp.on('close', cleanup);
    })();
  };

  // Opt out of the global rate limit: a single Testcontainers run legitimately
  // opens many short-lived Docker connections, each of which becomes its own
  // WebSocket to this endpoint (one WS per local TCP connection, by design —
  // see the CLI's tunnel bridge). The per-team parallelism cap enforced at
  // environment-assignment time is the real abuse control here, not a
  // per-request limiter on the byte pipe.
  app.get('/environments/:id/tunnel', { websocket: true, preHandler: requireApiTokenOrUser, config: { rateLimit: false } }, (socket, req) => {
    relay(socket, req, async () => {
      const { id } = req.params as { id: string };
      const teamId = teamIdOf(req);
      const row = await maybeOne<{ docker_endpoint: string | null; status: string }>(
        `SELECT docker_endpoint, status FROM environment_requests WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      if (!row || row.status !== 'assigned' || !row.docker_endpoint) {
        return { close: { code: 4004, reason: 'environment_not_ready' } };
      }
      const [host, portStr] = row.docker_endpoint.split(':');
      const port = Number(portStr);
      return dialTcp(host, port, row.docker_endpoint, req);
    });
  });

  app.get('/environments/:id/tunnel/:port', { websocket: true, preHandler: requireApiTokenOrUser, config: { rateLimit: false } }, (socket, req) => {
    relay(socket, req, async () => {
      const { id, port: portStr } = req.params as { id: string; port: string };
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { close: { code: 4400, reason: 'invalid_port' } };
      }
      const teamId = teamIdOf(req);
      // The same team/status guard as the docker_endpoint tunnel, joined
      // with the host row because reaching an arbitrary guest port goes
      // through that host's agent rather than a pre-provisioned DNAT.
      const row = await maybeOne<{ status: string; vm_id: string | null; agent_endpoint: string | null; agent_token: string | null }>(
        `SELECT er.status, er.vm_id, h.agent_endpoint, h.agent_token
         FROM environment_requests er
         LEFT JOIN hosts h ON h.id = er.host_id
         WHERE er.id = $1 AND er.team_id = $2`,
        [id, teamId],
      );
      if (!row || row.status !== 'assigned' || !row.vm_id || !row.agent_endpoint || !row.agent_token) {
        return { close: { code: 4004, reason: 'environment_not_ready' } };
      }
      return dialAgentProxy(row.agent_endpoint, row.agent_token, row.vm_id, port);
    });
  });
}

/** Plain TCP dial with a connect-phase timeout. A misrouted/black-holed
 *  endpoint (e.g. the host can't forward packets to the VM's tap device)
 *  doesn't refuse the connection, it just never answers — without an
 *  explicit timeout this would hang the tunnel (and whatever's waiting on
 *  the other end of it, like `docker version`) indefinitely instead of
 *  failing. */
function dialTcp(host: string, port: number, label: string, req: FastifyRequest): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const tcp = net.connect({ host, port, timeout: 10_000 });
    tcp.on('connect', () => {
      tcp.setTimeout(0); // connected — no more use for the connect-phase timeout
      tcp.removeAllListeners('error');
      tcp.removeAllListeners('timeout');
      resolve(tcp);
    });
    tcp.on('timeout', () => {
      req.log.warn({ endpoint: label }, 'tunnel: endpoint connection timed out');
      tcp.destroy();
      reject(new Error(`connection to ${label} timed out`));
    });
    tcp.on('error', (err) => reject(err));
  });
}

/** Dials the devplat-agent's per-port guest proxy and upgrades the HTTP
 *  connection to a raw TCP pipe. A non-101 response (VM gone, guest port
 *  refusing) rejects with the agent's error body so it lands in the log
 *  instead of looking like a silent hang. */
function dialAgentProxy(agentEndpoint: string, agentToken: string, vmId: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(agentEndpoint);
    } catch {
      reject(new Error(`invalid agent endpoint ${agentEndpoint}`));
      return;
    }
    const request = http.request({
      host: url.hostname,
      port: url.port ? Number(url.port) : 80,
      path: `/vms/${encodeURIComponent(vmId)}/proxy/${port}`,
      method: 'GET',
      headers: {
        authorization: `Bearer ${agentToken}`,
        connection: 'Upgrade',
        upgrade: 'tcp',
      },
      timeout: 15_000, // covers the agent's own 10s guest-dial timeout
    });
    request.on('upgrade', (_res, socket, head) => {
      socket.setTimeout(0);
      // Bytes the guest sent immediately after the 101 can already sit in
      // `head`; unshift puts them back at the front of the stream so the
      // relay's 'data' listener (attached after this resolves) sees them.
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { body += d; });
      res.on('end', () => reject(new Error(`agent proxy returned ${res.statusCode ?? 0}: ${body.slice(0, 300)}`)));
    });
    request.on('timeout', () => request.destroy(new Error('agent proxy connection timed out')));
    request.on('error', reject);
    request.end();
  });
}
