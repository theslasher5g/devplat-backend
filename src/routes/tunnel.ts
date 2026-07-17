import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { RawData } from 'ws';
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
 */
export default async function tunnelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/environments/:id/tunnel', { websocket: true, preHandler: requireApiTokenOrUser }, (socket, req) => {
    // The WebSocket handshake is already complete by the time this handler
    // runs — the client can start sending immediately. Everything below
    // needs a DB lookup and a TCP dial before it's ready to relay, so the
    // message listener and a buffer must be wired up synchronously, before
    // any `await`, or bytes sent in that window are silently dropped (this
    // was a real bug: worked in a slow manual test, failed reliably against
    // a fast client that writes right after connecting).
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
      const { id } = req.params as { id: string };
      const teamId = teamIdOf(req);
      const row = await maybeOne<{ docker_endpoint: string | null; status: string }>(
        `SELECT docker_endpoint, status FROM environment_requests WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      if (closed) return; // client disconnected while we were looking it up
      if (!row || row.status !== 'assigned' || !row.docker_endpoint) {
        socket.close(4004, 'environment_not_ready');
        return;
      }
      const [host, portStr] = row.docker_endpoint.split(':');
      const port = Number(portStr);

      tcp = net.connect({ host, port });
      tcp.on('connect', () => {
        tcpReady = true;
        for (const buf of pending) tcp!.write(buf);
        pending.length = 0;
      });
      tcp.on('data', (chunk) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk);
      });
      tcp.on('error', (err) => {
        req.log.warn({ err, dockerEndpoint: row.docker_endpoint }, 'tunnel: docker endpoint connection error');
        cleanup();
      });
      tcp.on('close', cleanup);
    })();
  });
}
