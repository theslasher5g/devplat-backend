import type { FastifyInstance } from 'fastify';
import { activePromo, config, type PlanTier } from '../config.js';
import { maybeOne, one } from '../db.js';
import { billableSeats, getPlan, maxFootprintGb, monthlyCost } from '../plans.js';
import { currentSeats } from '../lib/seats.js';
import { ensureStripeCustomer, requireStripe } from '../lib/stripe.js';
import { requireTeamAdmin } from '../plugins/auth.js';

export default async function billingRoutes(app: FastifyInstance): Promise<void> {
  // Public: the active seasonal promo, for the marketing promo banner. Returns
  // { active: false } when none is running.
  app.get('/promo', async () => {
    const promo = activePromo();
    return promo
      ? { active: true, label: promo.label, code: promo.code, endsAt: promo.endsAt || null }
      : { active: false };
  });

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
    // Seats are now part of what the team pays, so they belong in the summary
    // the billing page renders. Counted here rather than derived on the client:
    // the invoice is built from this number, and a page that computes its own
    // is a page that can disagree with the charge.
    const seats = await currentSeats(req.membership.teamId);
    return {
      planTier: team.plan_tier,
      planLabel: plan.label,
      parallelEnvironments: plan.parallelEnvs,
      vcpuPerEnvironment: plan.vcpuPerEnv,
      ramGbPerEnvironment: plan.ramMbPerEnv / 1024,
      maxFootprintGb: maxFootprintGb(plan),
      /** Base price. Kept as-is rather than renamed: existing clients read it. */
      chfMonthly: plan.chfMonthly,
      chfPerSeatMonthly: plan.chfPerSeatMonthly,
      includedSeats: plan.includedSeats,
      /** People in the team right now — the number seats are charged from. */
      seats,
      billableSeats: billableSeats(plan, seats),
      /** Base + seats. Null on a tier whose price is agreed rather than
       *  computed, so the page shows "on request" instead of inventing one. */
      chfTotalMonthly: monthlyCost(plan, seats),
      maxSeats: plan.maxMembers,
      selfServe: plan.selfServe,
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

    // A tier that is no longer offered, or one that is sold by conversation
    // rather than by button, must not be reachable through checkout — including
    // by someone posting the tier name directly. The pricing page hides them;
    // this is what makes hiding them mean something.
    const plan = getPlan(tier);
    if (!plan.available) {
      return reply.code(410).send({
        error: 'plan_retired',
        detail: `${plan.label} is no longer offered. See the pricing page for the current plans.`,
      });
    }
    if (!plan.selfServe) {
      return reply.code(409).send({
        error: 'contact_sales',
        detail: `${plan.label} is set up together with us rather than bought online. Send an enquiry and we will get back to you.`,
      });
    }

    const priceId = config.stripePrices[tier][interval];
    if (!priceId) return reply.code(500).send({ error: 'price_not_configured', detail: `${tier}/${interval}` });

    // Seats are charged as a second line item on top of the base.
    //
    // If the tier charges per seat but no seat price is configured, this
    // REFUSES rather than falling back to the base alone. The fallback would
    // create a real subscription that silently never bills for seats — money
    // quietly not collected, on exactly the accounts that grow, discovered
    // months later. A failed checkout is loud and fixable; a subscription
    // missing its seat line is neither.
    const lineItems: { price: string; quantity: number }[] = [{ price: priceId, quantity: 1 }];
    if (plan.chfPerSeatMonthly > 0) {
      const seatPrice = config.stripeSeatPrices[tier][interval];
      if (!seatPrice) {
        req.log.error({ tier, interval }, 'seat price missing for a per-seat tier — refusing checkout');
        return reply.code(500).send({
          error: 'seat_price_not_configured',
          detail: `${tier}/${interval} bills per seat but no seat price is set up. Checkout is refused rather than billing the base only.`,
        });
      }
      const seats = await currentSeats(req.membership.teamId);
      const billable = billableSeats(plan, seats);
      // Quantity 0 is valid and correct for a team inside its included seats —
      // Stripe accepts a zero-quantity line, and it means the item is there and
      // ready to grow rather than having to be added later.
      lineItems.push({ price: seatPrice, quantity: billable });
    }

    const customerId = await ensureStripeCustomer(req.membership.teamId, req.user.email);
    // A live campaign auto-applies its coupon (no code to type). Stripe Checkout
    // forbids `discounts` and `allow_promotion_codes` together, so it's one or
    // the other: auto-apply when a campaign is running, otherwise let the
    // customer enter a promotion code by hand.
    const promo = activePromo();
    const session = await requireStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      success_url: `${config.frontendUrl}/app/billing?checkout=success`,
      cancel_url: `${config.frontendUrl}/app/billing?checkout=cancelled`,
      client_reference_id: req.membership.teamId,
      subscription_data: { metadata: { team_id: req.membership.teamId } },
      ...(promo
        ? { discounts: [{ coupon: promo.couponId }] }
        : { allow_promotion_codes: true }),
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
