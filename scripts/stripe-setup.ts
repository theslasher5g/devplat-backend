/**
 * One-off: create the devplat products & prices in Stripe (run against test
 * mode first, then live). Prints the env lines to paste into .env.
 * Idempotent via lookup_keys — re-running reuses existing prices.
 *
 * Usage: STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
 */
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY');
  process.exit(1);
}
const stripe = new Stripe(key);

// Yearly = 12 × monthly × 0.83 (−17 %), rounded to whole CHF.
const TIERS = [
  { tier: 'solo', name: 'devplat Solo', monthlyChf: 29, envs: 2 },
  { tier: 'team', name: 'devplat Team', monthlyChf: 79, envs: 5 },
  { tier: 'scale', name: 'devplat Scale', monthlyChf: 199, envs: 15 },
] as const;

async function findPrice(lookupKey: string): Promise<Stripe.Price | null> {
  const res = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  return res.data[0] ?? null;
}

async function main(): Promise<void> {
  const envLines: string[] = [];
  for (const { tier, name, monthlyChf, envs } of TIERS) {
    let product: Stripe.Product;
    const existing = await stripe.products.search({ query: `metadata['devplat_tier']:'${tier}'` });
    if (existing.data[0]) {
      product = existing.data[0];
    } else {
      product = await stripe.products.create({
        name,
        description: `${envs} parallel test environments, flat pricing`,
        metadata: { devplat_tier: tier },
      });
    }

    for (const interval of ['monthly', 'yearly'] as const) {
      const lookupKey = `devplat_${tier}_${interval}`;
      let price = await findPrice(lookupKey);
      if (!price) {
        const amountChf = interval === 'monthly' ? monthlyChf : Math.round(monthlyChf * 12 * 0.83);
        price = await stripe.prices.create({
          product: product.id,
          currency: 'chf',
          unit_amount: amountChf * 100,
          recurring: { interval: interval === 'monthly' ? 'month' : 'year' },
          lookup_key: lookupKey,
          metadata: { devplat_tier: tier, devplat_interval: interval },
        });
      }
      envLines.push(`STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}=${price.id}`);
    }
  }
  console.log('\nAdd to your .env:\n');
  console.log(envLines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
