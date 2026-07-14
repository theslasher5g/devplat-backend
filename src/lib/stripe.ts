import Stripe from 'stripe';
import { config } from '../config.js';
import { one, query } from '../db.js';

export const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

export function requireStripe(): Stripe {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY is not configured');
  return stripe;
}

/** Get the team's Stripe customer, creating it on first use. */
export async function ensureStripeCustomer(teamId: string, email: string): Promise<string> {
  const team = await one<{ stripe_customer_id: string | null; name: string }>(
    'SELECT stripe_customer_id, name FROM teams WHERE id = $1',
    [teamId],
  );
  if (team.stripe_customer_id) return team.stripe_customer_id;
  const customer = await requireStripe().customers.create({
    email,
    name: team.name,
    metadata: { team_id: teamId },
  });
  await query('UPDATE teams SET stripe_customer_id = $1 WHERE id = $2', [customer.id, teamId]);
  return customer.id;
}
