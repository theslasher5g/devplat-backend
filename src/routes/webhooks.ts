import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { config, tierForPrice } from '../config.js';
import { maybeOne, query } from '../db.js';
import { rewardReferralOnSubscription } from '../lib/referral.js';
import { requireStripe } from '../lib/stripe.js';

async function teamIdForEvent(obj: { metadata?: Stripe.Metadata | null; customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null }): Promise<string | null> {
  if (obj.metadata?.team_id) return obj.metadata.team_id;
  const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
  if (!customerId) return null;
  const row = await maybeOne<{ id: string }>('SELECT id FROM teams WHERE stripe_customer_id = $1', [customerId]);
  return row?.id ?? null;
}

async function syncSubscription(teamId: string, sub: Stripe.Subscription): Promise<void> {
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;
  const mapped = priceId ? tierForPrice(priceId) : null;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  await query(
    `INSERT INTO subscriptions (team_id, stripe_subscription_id, stripe_price_id, status, current_period_end)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (team_id) DO UPDATE SET
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id = EXCLUDED.stripe_price_id,
       status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       updated_at = now()`,
    [teamId, sub.id, priceId, sub.status, periodEnd],
  );

  // Only an active/trialing subscription grants a paid tier.
  const paidStatus = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  const tier = paidStatus && mapped ? mapped.tier : 'free';
  await query('UPDATE teams SET plan_tier = $1 WHERE id = $2', [tier, teamId]);

  // Becoming a real paying customer (active, on a mapped paid tier) is what
  // fulfils a pending referral — reward both teams with a free month. Idempotent
  // (only pending referrals are rewarded), best-effort, never blocks the webhook.
  if (sub.status === 'active' && mapped) {
    await rewardReferralOnSubscription(teamId).catch((err) => console.error('[referral] reward failed', err));
  }
}

export default async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Stripe signature verification needs the exact raw payload. This parser is
  // scoped to this plugin (Fastify encapsulation), so the rest of the API
  // keeps normal JSON parsing.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Opt out of the global rate limit: this is called by Stripe (already
  // authenticated by signature verification below), can legitimately burst
  // during retries/backfills, and dropping a billing event to a limiter
  // would silently desync a team's plan tier.
  app.post('/webhooks/stripe', { config: { rateLimit: false } }, async (req, reply) => {
    const signature = req.headers['stripe-signature'];
    if (!signature || !config.stripeWebhookSecret) {
      return reply.code(400).send({ error: 'missing_signature_or_secret' });
    }
    let event: Stripe.Event;
    try {
      event = requireStripe().webhooks.constructEvent(req.body as Buffer, signature, config.stripeWebhookSecret);
    } catch (err) {
      req.log.warn({ err }, 'stripe webhook signature verification failed');
      return reply.code(400).send({ error: 'invalid_signature' });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.subscription) break;
        const teamId = session.client_reference_id ?? (await teamIdForEvent(session));
        if (!teamId) {
          req.log.error({ session: session.id }, 'checkout completed but no team could be resolved');
          break;
        }
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const sub = await requireStripe().subscriptions.retrieve(subId);
        await syncSubscription(teamId, sub);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const teamId = await teamIdForEvent(sub);
        if (teamId) await syncSubscription(teamId, sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const teamId = await teamIdForEvent(sub);
        if (teamId) {
          await query(
            `UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE team_id = $1`,
            [teamId],
          );
          await query("UPDATE teams SET plan_tier = 'free' WHERE id = $1", [teamId]);
        }
        break;
      }
      default:
        req.log.debug({ type: event.type }, 'unhandled stripe event');
    }

    return { received: true };
  });
}
