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
// Safety valves against an authenticated client opening many tunnels to
// amplify resource use (these routes are deliberately exempt from the global
// rate limit — see below). Neither trips in legitimate use: a Testcontainers
// run opens many short-lived connections, but rarely hundreds at once against
// one environment, and only ever buffers a request's worth of bytes during
// the sub-second upstream dial. They cap the worst case rather than shape the
// common one.
const MAX_TUNNELS_PER_ENV = 512;
// Bytes a client may buffer BEFORE the upstream socket is ready. This window
// is just the dial latency (well under a second over WireGuard), so real
// pre-connect data is a few KB; anything approaching this is a client
// streaming into a pipe that isn't draining yet.
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export default async function tunnelRoutes(app: FastifyInstance): Promise<void> {
  // Active tunnel count per environment id, for MAX_TUNNELS_PER_ENV. Entries
  // are deleted when they hit zero so this can't grow unbounded across the
  // lifetime of the process.
  const activeTunnels = new Map<string, number>();

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
    envId: string,
    connect: () => Promise<net.Socket | { close: { code: number; reason: string } }>,
  ): void => {
    const openNow = activeTunnels.get(envId) ?? 0;
    if (openNow >= MAX_TUNNELS_PER_ENV) {
      req.log.warn({ envId, openNow }, 'tunnel: per-environment tunnel cap reached');
      if (socket.readyState === socket.OPEN) socket.close(4429, 'too_many_tunnels');
      return;
    }
    activeTunnels.set(envId, openNow + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = (activeTunnels.get(envId) ?? 1) - 1;
      if (next <= 0) activeTunnels.delete(envId);
      else activeTunnels.set(envId, next);
    };

    const pending: Buffer[] = [];
    let pendingBytes = 0;
    let tcp: net.Socket | null = null;
    let tcpReady = false;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      release();
      tcp?.destroy();
      // Explicit code: a bare socket.close() sends a zero-length close frame,
      // which RFC 6455 requires peers to report as 1005 "no status received" —
      // the CLI's bridge (and any other WS client) then can't tell this
      // completely normal teardown from an actual failure. 1000 makes every
      // ordinary connection end (client done, container stopped, etc.) show up
      // as a normal closure instead of a scary-looking error.
      if (socket.readyState === socket.OPEN) socket.close(1000, 'closed');
    };

    socket.on('message', (data: RawData) => {
      const buf = data as Buffer;
      if (tcpReady && tcp) {
        tcp.write(buf);
        return;
      }
      pendingBytes += buf.length;
      if (pendingBytes > MAX_PENDING_BYTES) {
        req.log.warn({ envId, pendingBytes }, 'tunnel: pre-connect buffer cap exceeded');
        if (socket.readyState === socket.OPEN) socket.close(4013, 'buffer_overflow');
        cleanup();
        return;
      }
      pending.push(buf);
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    // If the client already closed between the handshake and here (a fast
    // client that bails, or a close queued during the async preHandler), the
    // 'close' event may have fired before the listener above was attached —
    // in which case cleanup() would never run and this env's tunnel count
    // would leak upward toward MAX_TUNNELS_PER_ENV. Reconcile explicitly.
    if (socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) {
      cleanup();
      return;
    }

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
    const { id } = req.params as { id: string };
    relay(socket, req, id, async () => {
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
    const { id, port: portStr } = req.params as { id: string; port: string };
    relay(socket, req, id, async () => {
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
      resolve(tcp);
    });
    tcp.on('timeout', () => {
      req.log.warn({ endpoint: label }, 'tunnel: endpoint connection timed out');
      tcp.destroy();
      reject(new Error(`connection to ${label} timed out`));
    });
    // Keep this 'error' listener attached even after resolve. The caller
    // re-attaches its own on a later microtask (after `await`); removing this
    // one on connect would leave a window with NO 'error' listener, and a
    // socket 'error' with no listener is thrown as an uncaught exception that
    // crashes the process. After resolve, reject() is a settled no-op, so the
    // only effect of leaving it is that the socket always has a handler.
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
      // The caller attaches its 'error'/'data'/'close' handlers on a later
      // microtask (after `await`). Attach a persistent 'error' listener now
      // so the upgraded socket is never without one — a socket 'error' with
      // no listener is thrown as an uncaught exception that crashes the
      // process. This handler is additive; the caller's cleanup still runs.
      socket.on('error', () => {});
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
