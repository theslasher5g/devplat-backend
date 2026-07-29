import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { maybeOne, one, query } from '../db.js';
import { auditFromReq } from '../lib/audit.js';
import { validateWebhookUrl } from '../lib/ssrfGuard.js';
import { WEBHOOK_EVENTS, generateWebhookSecret, isWebhookEvent } from '../lib/webhooks.js';
import { requireMember, requireTeamAdmin } from '../plugins/auth.js';

/** Fan-out ceiling. Every event is duplicated per endpoint, so this bounds both
 *  the delivery queue and the damage a careless integration can do. */
const MAX_ENDPOINTS_PER_TEAM = 10;

/** Only the tail of the secret is ever shown again after creation — enough to
 *  tell two endpoints apart when reading the list, useless to an attacker. */
function maskSecret(secret: string): string {
  return `whsec_…${secret.slice(-6)}`;
}

interface EndpointRow {
  id: string; url: string; secret: string; events: string[]; description: string | null;
  enabled: boolean; disabled_reason: string | null; consecutive_failures: number;
  last_success_at: string | null; last_failure_at: string | null; created_at: string;
}

function present(e: EndpointRow) {
  return {
    id: e.id,
    url: e.url,
    events: e.events,
    description: e.description,
    enabled: e.enabled,
    disabledReason: e.disabled_reason,
    consecutiveFailures: e.consecutive_failures,
    lastSuccessAt: e.last_success_at,
    lastFailureAt: e.last_failure_at,
    createdAt: e.created_at,
    secretHint: maskSecret(e.secret),
  };
}

const ENDPOINT_COLUMNS = `id, url, secret, events, description, enabled, disabled_reason,
  consecutive_failures, last_success_at, last_failure_at, created_at`;

/**
 * Team-managed outgoing webhook endpoints and their delivery log.
 *
 * Mutations require team admin: an endpoint is an outbound copy of everything
 * that happens in the team's infrastructure, so adding one is closer to
 * granting access than to changing a preference.
 */
export default async function outgoingWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/webhook-endpoints', { preHandler: requireMember }, async (req) => {
    const res = await query<EndpointRow>(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE team_id = $1 ORDER BY created_at DESC`,
      [req.membership.teamId],
    );
    return { endpoints: res.rows.map(present), availableEvents: WEBHOOK_EVENTS };
  });

  app.post('/webhook-endpoints', {
    preHandler: requireTeamAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 200 },
          // Empty means every event, including ones added later.
          events: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
        },
      },
    },
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { url, description, events = [] } = req.body as {
      url: string; description?: string; events?: string[];
    };
    const teamId = req.membership.teamId;

    const checked = validateWebhookUrl(url.trim(), config.webhookAllowPrivateTargets);
    if ('error' in checked) return reply.code(400).send({ error: 'invalid_url', detail: checked.error });

    const unknown = events.filter((e) => !isWebhookEvent(e));
    if (unknown.length > 0) {
      return reply.code(400).send({
        error: 'unknown_event',
        detail: `Unknown event${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Known events: ${WEBHOOK_EVENTS.join(', ')}.`,
      });
    }

    const count = await one<{ count: string }>(
      'SELECT count(*) FROM webhook_endpoints WHERE team_id = $1', [teamId],
    );
    if (Number(count.count) >= MAX_ENDPOINTS_PER_TEAM) {
      return reply.code(409).send({
        error: 'endpoint_limit_reached',
        detail: `A team can have at most ${MAX_ENDPOINTS_PER_TEAM} webhook endpoints.`,
      });
    }

    const secret = generateWebhookSecret();
    const row = await one<EndpointRow>(
      `INSERT INTO webhook_endpoints (team_id, url, secret, events, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${ENDPOINT_COLUMNS}`,
      [teamId, checked.url.toString(), secret, events, description?.trim() || null, req.user.id],
    );
    await auditFromReq(req, 'webhook.create', { target: checked.url.host, detail: { events } });
    // The secret is returned exactly once here and on rotation. It stays in the
    // database because HMAC signing needs the same bytes the receiver has — but
    // there's no reason to keep handing it back on every list call.
    return reply.code(201).send({ ...present(row), secret });
  });

  app.patch('/webhook-endpoints/:id', {
    preHandler: requireTeamAdmin,
    schema: {
      body: {
        type: 'object',
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 200 },
          events: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { url?: string; description?: string; events?: string[]; enabled?: boolean };
    const teamId = req.membership.teamId;

    const existing = await maybeOne<{ id: string }>(
      'SELECT id FROM webhook_endpoints WHERE id = $1 AND team_id = $2', [id, teamId],
    );
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    let url: string | undefined;
    if (body.url !== undefined) {
      const checked = validateWebhookUrl(body.url.trim(), config.webhookAllowPrivateTargets);
      if ('error' in checked) return reply.code(400).send({ error: 'invalid_url', detail: checked.error });
      url = checked.url.toString();
    }
    if (body.events) {
      const unknown = body.events.filter((e) => !isWebhookEvent(e));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: 'unknown_event', detail: `Unknown events: ${unknown.join(', ')}.` });
      }
    }

    // Re-enabling clears both the strike count and the explanation — otherwise
    // an endpoint switched back on would be one failure away from being
    // disabled again, and would still be showing why it was disabled last time.
    const row = await one<EndpointRow>(
      `UPDATE webhook_endpoints SET
         url = COALESCE($3, url),
         description = COALESCE($4, description),
         events = COALESCE($5::text[], events),
         enabled = COALESCE($6, enabled),
         disabled_reason = CASE WHEN $6 IS TRUE THEN NULL ELSE disabled_reason END,
         consecutive_failures = CASE WHEN $6 IS TRUE THEN 0 ELSE consecutive_failures END
       WHERE id = $1 AND team_id = $2 RETURNING ${ENDPOINT_COLUMNS}`,
      [id, teamId, url ?? null, body.description?.trim() ?? null, body.events ?? null, body.enabled ?? null],
    );
    await auditFromReq(req, 'webhook.update', { target: row.url, detail: { enabled: row.enabled } });
    return present(row);
  });

  app.post('/webhook-endpoints/:id/rotate-secret', { preHandler: requireTeamAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const secret = generateWebhookSecret();
    const row = await maybeOne<EndpointRow>(
      `UPDATE webhook_endpoints SET secret = $3 WHERE id = $1 AND team_id = $2 RETURNING ${ENDPOINT_COLUMNS}`,
      [id, req.membership.teamId, secret],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await auditFromReq(req, 'webhook.rotate_secret', { target: row.url });
    // Rotation takes effect on the next delivery. Deliveries already queued
    // will be signed with the new secret too — they're signed at send time, not
    // at enqueue time — so a receiver should switch over immediately.
    return { ...present(row), secret };
  });

  // Queues a synthetic event against one endpoint, so an integration can be
  // verified without waiting for a real run to happen.
  app.post('/webhook-endpoints/:id/test', {
    preHandler: requireTeamAdmin,
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const teamId = req.membership.teamId;
    const endpoint = await maybeOne<{ id: string }>(
      'SELECT id FROM webhook_endpoints WHERE id = $1 AND team_id = $2', [id, teamId],
    );
    if (!endpoint) return reply.code(404).send({ error: 'not_found' });

    const delivery = await one<{ id: string; event_id: string }>(
      `INSERT INTO webhook_deliveries (endpoint_id, team_id, event_type, event_id, payload)
       VALUES ($1, $2, 'environment.assigned', gen_random_uuid(),
               jsonb_build_object(
                 'id', gen_random_uuid(), 'type', 'environment.assigned', 'test', true,
                 'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 'teamId', $2::text,
                 'data', jsonb_build_object('requestId', gen_random_uuid(), 'status', 'assigned',
                                            'note', 'This is a test delivery from devplat.')))
       RETURNING id, event_id`,
      [id, teamId],
    );
    // 202: it's queued, not sent. The delivery worker picks it up within
    // seconds; the caller polls the delivery log for the outcome.
    return reply.code(202).send({ deliveryId: delivery.id, eventId: delivery.event_id });
  });

  app.delete('/webhook-endpoints/:id', { preHandler: requireTeamAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await maybeOne<{ url: string }>(
      'DELETE FROM webhook_endpoints WHERE id = $1 AND team_id = $2 RETURNING url',
      [id, req.membership.teamId],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await auditFromReq(req, 'webhook.delete', { target: row.url });
    return { ok: true };
  });

  // Recent deliveries across the team's endpoints — the "did it arrive, and if
  // not, what did they say" view.
  app.get('/webhook-deliveries', { preHandler: requireMember }, async (req) => {
    const q = req.query as { endpointId?: string; status?: string };
    const res = await query<{
      id: string; endpoint_id: string; url: string; event_type: string; status: string;
      attempts: number; response_status: number | null; response_body: string | null;
      error: string | null; created_at: string; delivered_at: string | null; next_attempt_at: string;
    }>(
      `SELECT d.id, d.endpoint_id, e.url, d.event_type, d.status, d.attempts,
              d.response_status, d.response_body, d.error, d.created_at, d.delivered_at, d.next_attempt_at
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.team_id = $1
         AND ($2::uuid IS NULL OR d.endpoint_id = $2)
         AND ($3::text IS NULL OR d.status = $3)
       ORDER BY d.created_at DESC LIMIT 100`,
      [req.membership.teamId, q.endpointId ?? null, q.status ?? null],
    );
    return {
      deliveries: res.rows.map((d) => ({
        id: d.id,
        endpointId: d.endpoint_id,
        url: d.url,
        eventType: d.event_type,
        status: d.status,
        attempts: d.attempts,
        responseStatus: d.response_status,
        responseBody: d.response_body,
        error: d.error,
        createdAt: d.created_at,
        deliveredAt: d.delivered_at,
        nextAttemptAt: d.next_attempt_at,
      })),
    };
  });

  // Re-queue a delivery that gave up. Resets the attempt counter so it gets the
  // full retry ladder again rather than failing on the first stumble.
  app.post('/webhook-deliveries/:id/redeliver', {
    preHandler: requireTeamAdmin,
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await maybeOne<{ id: string }>(
      `UPDATE webhook_deliveries
       SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL
       WHERE id = $1 AND team_id = $2 AND status = 'failed' RETURNING id`,
      [id, req.membership.teamId],
    );
    if (!row) return reply.code(404).send({ error: 'not_found_or_not_failed' });
    return reply.code(202).send({ ok: true });
  });
}
