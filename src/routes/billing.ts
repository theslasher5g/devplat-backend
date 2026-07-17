import type { FastifyInstance } from 'fastify';
import { config, type PlanTier } from '../config.js';
import { maybeOne, one } from '../db.js';
import { getPlan, maxFootprintGb } from '../plans.js';
import { ensureStripeCustomer, requireStripe } from '../lib/stripe.js';
import { requireTeamAdmin } from '../plugins/auth.js';

export default async function billingRoutes(app: FastifyInstance): Promise<void> {
  // Current plan + subscription state for the dashboard's billing view.
  app.get('/billing/subscription', { preHandler: requireTeamAdmin }, async (req) => {
    const team = await one<{ plan_tier: PlanTier; trial_ends_at: string; stripe_customer_id: string | null }>(
      'SELECT plan_tier, trial_ends_at, stripe_customer_id FROM teams WHERE id = $1',
      [req.membership.teamId],
    );
    const sub = await maybeOne<{ status: string; current_period_end: string | null; stripe_price_id: string | null }>(
      'SELECT status, current_period_end, stripe_price_id FROM subscriptions WHERE team_id = $1',
      [req.membership.teamId],
    );
    const plan = getPlan(team.plan_tier);
    return {
      planTier: team.plan_tier,
      planLabel: plan.label,
      parallelEnvironments: plan.parallelEnvs,
      vcpuPerEnvironment: plan.vcpuPerEnv,
      ramGbPerEnvironment: plan.ramMbPerEnv / 1024,
      maxFootprintGb: maxFootprintGb(plan),
      chfMonthly: plan.chfMonthly,
      trialEndsAt: team.plan_tier === 'free' ? team.trial_ends_at : null,
      subscription: sub
        ? { status: sub.status, currentPeriodEnd: sub.current_period_end, priceId: sub.stripe_price_id }
        : null,
      hasStripeCustomer: !!team.stripe_customer_id,
    };
  });

  app.post('/billing/checkout', {
    preHandler: requireTeamAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['tier', 'interval'],
        properties: {
          tier: { type: 'string', enum: ['solo', 'team', 'scale'] },
          interval: { type: 'string', enum: ['monthly', 'yearly'] },
        },
      },
    },
  }, async (req, reply) => {
    const { tier, interval } = req.body as { tier: 'solo' | 'team' | 'scale'; interval: 'monthly' | 'yearly' };
    const priceId = config.stripePrices[tier][interval];
    if (!priceId) return reply.code(500).send({ error: 'price_not_configured', detail: `${tier}/${interval}` });

    const customerId = await ensureStripeCustomer(req.membership.teamId, req.user.email);
    const session = await requireStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${config.frontendUrl}/app/billing?checkout=success`,
      cancel_url: `${config.frontendUrl}/app/billing?checkout=cancelled`,
      client_reference_id: req.membership.teamId,
      subscription_data: { metadata: { team_id: req.membership.teamId } },
      allow_promotion_codes: true,
    });
    return { url: session.url };
  });

  app.post('/billing/portal', { preHandler: requireTeamAdmin }, async (req, reply) => {
    const team = await one<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM teams WHERE id = $1',
      [req.membership.teamId],
    );
    if (!team.stripe_customer_id) return reply.code(400).send({ error: 'no_stripe_customer' });
    const session = await requireStripe().billingPortal.sessions.create({
      customer: team.stripe_customer_id,
      return_url: `${config.frontendUrl}/app/billing`,
    });
    return { url: session.url };
  });

  app.get('/billing/invoices', { preHandler: requireTeamAdmin }, async (req) => {
    const team = await one<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM teams WHERE id = $1',
      [req.membership.teamId],
    );
    if (!team.stripe_customer_id) return { invoices: [] };
    const list = await requireStripe().invoices.list({ customer: team.stripe_customer_id, limit: 12 });
    return {
      invoices: list.data.map((inv) => ({
        id: inv.id,
        number: inv.number,
        created: new Date(inv.created * 1000).toISOString(),
        amount: (inv.total ?? 0) / 100,
        currency: inv.currency?.toUpperCase() ?? 'CHF',
        status: inv.status,
        pdfUrl: inv.invoice_pdf ?? null,
      })),
    };
  });
}
