/**
 * Create the devplat products & prices in Stripe (run against test mode first,
 * then live). Prints the env lines to paste into .env.
 * Idempotent via lookup_keys — re-running reuses existing prices.
 *
 * Usage: STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
 *
 * Prices are read from the `plans` table, not written here. The previous version
 * carried its own list, and that list had drifted: it created Solo at CHF 29
 * where the database said 19, and Scale at CHF 199 where the database said 249.
 * Since the pricing page renders from the database and Stripe charges from these
 * prices, the two disagreed about what a customer pays — the class of bug that
 * only surfaces on the first invoice. Reading one source removes the possibility.
 *
 * Two prices per tier per interval where a tier bills per seat:
 *   devplat_<tier>_<interval>       the base price, quantity 1
 *   devplat_<tier>_seat_<interval>  per additional developer, quantity = seats
 * Both are licensed (not metered): we set the quantity, Stripe does not measure
 * it. They must share a billing interval or Stripe rejects the subscription.
 */
import Stripe from 'stripe';
import { pool } from '../src/db.js';
import { loadPlans, purchasablePlans } from '../src/plans.js';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY');
  process.exit(1);
}
const stripe = new Stripe(key);

/** Yearly = 12 × monthly × 0.83 (−17 %), rounded to whole CHF. Matches
 *  YEARLY_FACTOR on the pricing page. */
const YEARLY_FACTOR = 0.83;
function yearlyChf(monthlyChf: number): number {
  return Math.round(monthlyChf * 12 * YEARLY_FACTOR);
}

async function findPrice(lookupKey: string): Promise<Stripe.Price | null> {
  const res = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  return res.data[0] ?? null;
}

/** Reuse the price under this lookup key, or create it. Never updates an
 *  existing one: Stripe prices are immutable by design, and silently pointing a
 *  lookup key at a new amount would change what live subscribers are charged. A
 *  price change is a new lookup key and a deliberate migration. */
async function ensurePrice(
  productId: string, lookupKey: string, amountChf: number,
  interval: 'monthly' | 'yearly', metadata: Record<string, string>,
): Promise<Stripe.Price> {
  const existing = await findPrice(lookupKey);
  if (existing) {
    const wantCents = amountChf * 100;
    if (existing.unit_amount !== wantCents) {
      console.warn(
        `  ! ${lookupKey} exists at ${(existing.unit_amount ?? 0) / 100} CHF but the plans table says `
        + `${amountChf} CHF. Keeping the existing price — Stripe prices are immutable, and repointing `
        + `this key would change what current subscribers pay. Create a new price deliberately if the `
        + `change is intended.`,
      );
    }
    return existing;
  }
  return stripe.prices.create({
    product: productId,
    currency: 'chf',
    unit_amount: amountChf * 100,
    recurring: { interval: interval === 'monthly' ? 'month' : 'year' },
    lookup_key: lookupKey,
    metadata,
  });
}

async function main(): Promise<void> {
  await loadPlans();

  // Only tiers a customer can buy themselves. A retired tier needs no price —
  // checkout refuses it with 410 — and a sales-led one is subscribed by hand
  // after a conversation, which is the whole reason it carries no number.
  const tiers = purchasablePlans().filter((p) => p.selfServe && p.chfMonthly > 0);
  if (tiers.length === 0) {
    console.error('No self-serve paid tier in the plans table — nothing to create. Run migrations first.');
    process.exit(1);
  }

  const envLines: string[] = [];
  for (const plan of tiers) {
    console.log(`\n${plan.label} (${plan.tier}) — CHF ${plan.chfMonthly}/mo`
      + (plan.chfPerSeatMonthly > 0
        ? ` + CHF ${plan.chfPerSeatMonthly}/seat beyond ${plan.includedSeats}`
        : ''));

    let product: Stripe.Product;
    const existing = await stripe.products.search({ query: `metadata['devplat_tier']:'${plan.tier}'` });
    if (existing.data[0]) {
      product = existing.data[0];
    } else {
      product = await stripe.products.create({
        name: `devplat ${plan.label}`,
        description: `${plan.parallelEnvs} parallel test environments · `
          + `${plan.includedSeats} developer${plan.includedSeats === 1 ? '' : 's'} included`,
        metadata: { devplat_tier: plan.tier },
      });
    }

    for (const interval of ['monthly', 'yearly'] as const) {
      const base = interval === 'monthly' ? plan.chfMonthly : yearlyChf(plan.chfMonthly);
      const price = await ensurePrice(
        product.id, `devplat_${plan.tier}_${interval}`, base, interval,
        { devplat_tier: plan.tier, devplat_interval: interval, devplat_kind: 'base' },
      );
      envLines.push(`STRIPE_PRICE_${plan.tier.toUpperCase()}_${interval.toUpperCase()}=${price.id}`);

      if (plan.chfPerSeatMonthly > 0) {
        // Its own product, so a Stripe invoice reads "devplat Team" and
        // "devplat Team — additional developer" as two lines rather than one
        // opaque total. The customer disputing a seat charge is reading this.
        const seatProductQuery = `metadata['devplat_tier']:'${plan.tier}' AND metadata['devplat_kind']:'seat'`;
        const seatFound = await stripe.products.search({ query: seatProductQuery });
        const seatProduct = seatFound.data[0] ?? await stripe.products.create({
          name: `devplat ${plan.label} — additional developer`,
          description: `Each developer beyond the ${plan.includedSeats} included in ${plan.label}`,
          metadata: { devplat_tier: plan.tier, devplat_kind: 'seat' },
        });
        const seat = interval === 'monthly'
          ? plan.chfPerSeatMonthly
          : yearlyChf(plan.chfPerSeatMonthly);
        const seatPrice = await ensurePrice(
          seatProduct.id, `devplat_${plan.tier}_seat_${interval}`, seat, interval,
          { devplat_tier: plan.tier, devplat_interval: interval, devplat_kind: 'seat' },
        );
        envLines.push(`STRIPE_SEAT_${plan.tier.toUpperCase()}_${interval.toUpperCase()}=${seatPrice.id}`);
      }
    }
  }

  console.log('\nAdd to your .env:\n');
  console.log(envLines.join('\n'));
  console.log(
    '\nBoth the base and the seat line are needed: POST /billing/checkout refuses with '
    + 'seat_price_not_configured rather than quietly billing the base only.',
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
