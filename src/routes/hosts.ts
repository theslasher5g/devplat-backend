import type { FastifyInstance } from 'fastify';
import { maybeOne, query } from '../db.js';
import { generateAgentToken } from '../lib/tokens.js';
import { requireAgentToken, requirePlatformAdmin } from '../plugins/auth.js';

/**
 * Host-pool registration (platform-admin only) and the agent heartbeat
 * receiver. Hosts are plain rows in `hosts` — no Host A/B special-casing —
 * so adding capacity (or an AWS host later) is just another POST here.
 */
export default async function hostRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/hosts (listing, with utilization) already lives in admin.ts —
  // this plugin only adds the write operations (register/rotate/remove) and
  // the agent heartbeat receiver.
  app.post('/admin/hosts', {
    preHandler: requirePlatformAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'agentEndpoint', 'wireguardIp', 'cpuTotal', 'ramTotalMb'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          location: { type: 'string', maxLength: 100 },
          agentEndpoint: { type: 'string', minLength: 1, maxLength: 255 },
          wireguardIp: { type: 'string', minLength: 1, maxLength: 45 },
          cpuTotal: { type: 'integer', minimum: 1 },
          ramTotalMb: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as {
      name: string; location?: string; agentEndpoint: string; wireguardIp: string;
      cpuTotal: number; ramTotalMb: number;
    };
    const existing = await maybeOne('SELECT 1 FROM hosts WHERE name = $1', [body.name]);
    if (existing) return reply.code(409).send({ error: 'host_name_taken' });

    const token = generateAgentToken();
    const row = await query<{ id: string; created_at: string }>(
      `INSERT INTO hosts (name, location, agent_endpoint, wireguard_ip, agent_token, cpu_total, ram_total_mb, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'offline')
       RETURNING id`,
      [body.name, body.location ?? 'CH-BSL-1', body.agentEndpoint, body.wireguardIp, token, body.cpuTotal, body.ramTotalMb],
    );
    // Put this into the agent's AGENT_TOKEN env on that host. It's shown
    // here once for convenience but — unlike api_tokens — remains readable
    // by the backend afterwards (see migrations/002_scheduler.sql); no user
    // endpoint exposes it again.
    return reply.code(201).send({ id: row.rows[0].id, name: body.name, agentToken: token });
  });

  app.patch('/admin/hosts/:id', {
    preHandler: requirePlatformAdmin,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          location: { type: 'string', maxLength: 100 },
          cpuTotal: { type: 'integer', minimum: 1 },
          ramTotalMb: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; location?: string; cpuTotal?: number; ramTotalMb?: number };
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { fields.push(`name = $${fields.length + 1}`); values.push(body.name); }
    if (body.location !== undefined) { fields.push(`location = $${fields.length + 1}`); values.push(body.location); }
    if (body.cpuTotal !== undefined) { fields.push(`cpu_total = $${fields.length + 1}`); values.push(body.cpuTotal); }
    if (body.ramTotalMb !== undefined) { fields.push(`ram_total_mb = $${fields.length + 1}`); values.push(body.ramTotalMb); }
    if (fields.length === 0) return reply.code(400).send({ error: 'no_fields' });
    values.push(id);
    const found = await maybeOne(`UPDATE hosts SET ${fields.join(', ')} WHERE id = $${fields.length + 1} RETURNING id`, values);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/admin/hosts/:id/rotate-token', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const token = generateAgentToken();
    const found = await maybeOne(
      'UPDATE hosts SET agent_token = $1 WHERE id = $2 RETURNING id',
      [token, id],
    );
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { agentToken: token };
  });

  app.delete('/admin/hosts/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await maybeOne('DELETE FROM hosts WHERE id = $1 RETURNING id', [id]);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Agent → scheduler heartbeat. No direct Postgres access from the hosts
  // (separate hardware behind WireGuard, Postgres has no public port), so
  // this HTTP call is the only way host status reaches the database.
  app.post('/internal/hosts/heartbeat', {
    preHandler: requireAgentToken,
    schema: {
      body: {
        type: 'object',
        required: ['cpuUsed', 'ramUsedMb', 'activeVmCount'],
        properties: {
          cpuUsed: { type: 'integer', minimum: 0 },
          ramUsedMb: { type: 'integer', minimum: 0 },
          activeVmCount: { type: 'integer', minimum: 0 },
          draining: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const { cpuUsed, ramUsedMb, draining } = req.body as {
      cpuUsed: number; ramUsedMb: number; activeVmCount: number; draining?: boolean;
    };
    await query(
      `UPDATE hosts SET last_heartbeat = now(), cpu_used = $1, ram_used_mb = $2,
              status = $3
       WHERE id = $4`,
      [cpuUsed, ramUsedMb, draining ? 'draining' : 'online', req.hostId],
    );
    return { ok: true };
  });
}
