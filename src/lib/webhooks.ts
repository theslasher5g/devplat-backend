import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import type { WebhookEvent } from './webhookSignature.js';

export {
  WEBHOOK_EVENTS, generateWebhookSecret, isWebhookEvent, signPayload, verifySignature,
} from './webhookSignature.js';
export type { WebhookEvent } from './webhookSignature.js';

/**
 * Queues an event for every enabled endpoint on the team that subscribes to it.
 *
 * Queued, never sent inline. A customer endpoint that takes 30 seconds to
 * answer would otherwise be sitting in the middle of VM assignment, and a
 * failed send would have nowhere to be retried from once the request that
 * triggered it had returned.
 *
 * Never throws. This is called from the scheduler's hot path, and a webhook
 * that can't be queued must not be able to fail an environment request —
 * notifying someone about a run is strictly less important than the run.
 */
export async function emitWebhook(
  teamId: string, eventType: WebhookEvent, data: Record<string, unknown>,
): Promise<void> {
  try {
    const eventId = randomUUID();
    const payload = {
      id: eventId,
      type: eventType,
      createdAt: new Date().toISOString(),
      teamId,
      data,
    };
    // An empty events array means "everything" — the default for a new
    // endpoint, and what keeps a team from silently missing an event type we
    // add later.
    await query(
      `INSERT INTO webhook_deliveries (endpoint_id, team_id, event_type, event_id, payload)
       SELECT id, team_id, $2, $3, $4::jsonb FROM webhook_endpoints
       WHERE team_id = $1 AND enabled = true
         AND (cardinality(events) = 0 OR $2 = ANY(events))`,
      [teamId, eventType, eventId, JSON.stringify(payload)],
    );
  } catch (err) {
    console.error(`[webhooks] could not queue ${eventType} for team ${teamId}`, err);
  }
}
