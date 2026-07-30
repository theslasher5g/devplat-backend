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
          drain: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; location?: string; cpuTotal?: number; ramTotalMb?: number; drain?: boolean };
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { fields.push(`name = $${fields.length + 1}`); values.push(body.name); }
    if (body.location !== undefined) { fields.push(`location = $${fields.length + 1}`); values.push(body.location); }
    if (body.cpuTotal !== undefined) { fields.push(`cpu_total = $${fields.length + 1}`); values.push(body.cpuTotal); }
    if (body.ramTotalMb !== undefined) { fields.push(`ram_total_mb = $${fields.length + 1}`); values.push(body.ramTotalMb); }
    if (body.drain !== undefined) { fields.push(`drain = $${fields.length + 1}`); values.push(body.drain); }
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
          cacheLookups: { type: 'integer', minimum: 0 },
          cacheHits: { type: 'integer', minimum: 0 },
          // Measured usage — see migration 035. All optional: an agent
          // predating this, or one whose guests haven't answered, sends none
          // of it, and that must stay distinguishable from a measured zero.
          ramCommittedMb: { type: 'integer', minimum: 0 },
          ramGrantedMb: { type: 'integer', minimum: 0 },
          ramGuestUsedMb: { type: 'integer', minimum: 0 },
          hostAvailableMb: { type: 'integer', minimum: 0 },
          cpuBusyPct: { type: 'integer', minimum: 0, maximum: 100 },
          cpuUsedVcpu: { type: 'number', minimum: 0 },
          throttledVms: { type: 'integer', minimum: 0 },
          // Overcommit setting and its cost — see migration 041. Reported on
          // every heartbeat rather than only alongside a complete memory
          // sample: a starved grant is most worth seeing exactly when the host
          // is in the state that stops its guests reporting cleanly.
          overcommitPct: { type: 'integer', minimum: 100, maximum: 1000 },
          starvedGrants: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (req) => {
    const {
      cpuUsed, ramUsedMb, draining, cacheLookups, cacheHits,
      ramCommittedMb, ramGrantedMb, ramGuestUsedMb, hostAvailableMb,
      cpuBusyPct, cpuUsedVcpu, throttledVms, overcommitPct, starvedGrants,
    } = req.body as {
      cpuUsed: number; ramUsedMb: number; activeVmCount: number; draining?: boolean;
      cacheLookups?: number; cacheHits?: number;
      ramCommittedMb?: number; ramGrantedMb?: number; ramGuestUsedMb?: number; hostAvailableMb?: number;
      cpuBusyPct?: number; cpuUsedVcpu?: number; throttledVms?: number;
      overcommitPct?: number; starvedGrants?: number;
    };
    // Cache counters are optional (absent when the host's registry debug
    // endpoint is off). COALESCE keeps the last known values instead of
    // nulling them on a heartbeat that happened to omit them.
    //
    // The usage columns take the same treatment, plus usage_reported_at is
    // stamped only when something was actually measured. That timestamp is what
    // lets a reader tell fresh measurements from an hour-old snapshot left
    // behind by an agent that has since stopped reporting — placing against
    // those would be placing against history.
    const measured = ramCommittedMb !== undefined || cpuBusyPct !== undefined;
    await query(
      `UPDATE hosts SET last_heartbeat = now(), cpu_used = $1, ram_used_mb = $2,
              status = $3,
              cache_lookups = COALESCE($4, cache_lookups),
              cache_hits = COALESCE($5, cache_hits),
              ram_committed_mb = COALESCE($6, ram_committed_mb),
              ram_granted_mb = COALESCE($7, ram_granted_mb),
              ram_guest_used_mb = COALESCE($8, ram_guest_used_mb),
              ram_host_available_mb = COALESCE($9, ram_host_available_mb),
              cpu_busy_pct = COALESCE($10, cpu_busy_pct),
              cpu_used_actual = COALESCE($11, cpu_used_actual),
              cpu_throttled_vms = COALESCE($12, cpu_throttled_vms),
              usage_reported_at = CASE WHEN $13 THEN now() ELSE usage_reported_at END,
              overcommit_pct = COALESCE($14, overcommit_pct),
              starved_grants = COALESCE($15, starved_grants),
              -- Stamped only when the count actually went up. The counter is
              -- cumulative for the life of the agent process, so a host that
              -- starved someone once during a spike last week would otherwise
              -- look identical to one starving guests this minute.
              starved_grants_at = CASE
                WHEN $15::bigint IS NOT NULL AND $15::bigint > COALESCE(starved_grants, 0)
                THEN now() ELSE starved_grants_at END
       WHERE id = $16`,
      [
        cpuUsed, ramUsedMb, draining ? 'draining' : 'online', cacheLookups ?? null, cacheHits ?? null,
        ramCommittedMb ?? null, ramGrantedMb ?? null, ramGuestUsedMb ?? null, hostAvailableMb ?? null,
        cpuBusyPct ?? null, cpuUsedVcpu ?? null, throttledVms ?? null,
        measured, overcommitPct ?? null, starvedGrants ?? null, req.hostId,
      ],
    );
    return { ok: true };
  });
}
