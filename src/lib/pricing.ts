import type { PlanTier } from '../config.js';

/**
 * What a plan costs, and whether we are billing the right number of seats.
 *
 * Import-free apart from a type, and that is the point. The arithmetic here
 * decides what a customer is charged, so it is the code most worth testing
 * exhaustively — and both of its previous homes (plans.ts, lib/seats.ts) reach
 * ../db.js through a chain of imports, which meant a test of pure multiplication
 * could not run without a live Postgres. That is how billing maths quietly stops
 * being tested. Third time this pattern has come up here, after
 * webhookSignature.ts and sanitize.ts.
 */

/** The pricing-relevant shape of a plan. Structural rather than importing Plan
 *  from plans.ts, which would drag the database back in. */
export interface Priced {
  chfMonthly: number;
  chfPerSeatMonthly: number;
  includedSeats: number;
  /** False for a tier whose price is agreed in a conversation. */
  selfServe: boolean;
}

/**
 * Seats charged for beyond the base allowance.
 *
 * Clamped at zero, and not defensively: a team legitimately sits below its
 * included seats when people leave, and a negative count would become a credit
 * nobody agreed to.
 */
export function billableSeats(plan: Priced, seats: number): number {
  return Math.max(0, seats - plan.includedSeats);
}

/**
 * Monthly cost for a team of `seats` people.
 *
 * Null for a tier with no published price. Computing a figure for a negotiated
 * plan would put a number on the pricing page that nobody agreed to charge.
 */
export function monthlyCost(plan: Priced, seats: number): number | null {
  if (!plan.selfServe) return null;
  return plan.chfMonthly + billableSeats(plan, seats) * plan.chfPerSeatMonthly;
}

/**
 * The next rung up a ladder that has gaps in it.
 *
 * Split out from plans.ts because the interesting case — skipping a retired
 * tier — could not be tested there: nextTierUp() reaches getPlan(), which needs
 * the cache filled from Postgres, so the one function whose bug is silent had
 * no reachable test. Same reason lib/pricing.ts exists at all.
 *
 * `available` decides what counts as a rung. A tier that can no longer be
 * bought is stepped over, not returned: after Solo was retired, the naive
 * `i + 1` answered "Solo" for every evaluation team that hit its limit, and
 * that plan's checkout refuses with 410. A suggestion nobody can act on is
 * worse than no suggestion.
 */
export function nextAvailable<T>(order: readonly T[], current: T, available: (tier: T) => boolean): T | null {
  const i = order.indexOf(current);
  if (i < 0) return null;
  for (const candidate of order.slice(i + 1)) {
    if (available(candidate)) return candidate;
  }
  return null;
}

/** The pricing-relevant shape of a plan, plus whether it can still be bought.
 *  Separate from Priced because monthlyCost() has no business knowing about
 *  retirement. */
export interface Offered extends Priced {
  available: boolean;
}

/**
 * The entry price: cheapest thing a customer can actually buy.
 *
 * Three exclusions, and each has a way of going wrong quietly:
 *  - Not available: a retired tier's checkout answers 410, so quoting it sends
 *    people to a wall.
 *  - Not self-serve: a negotiated tier has no price to quote.
 *  - Free: the trial would win on price every time and turn "plans start at
 *    CHF 190" into "plans start at CHF 0" — technically the cheapest, and
 *    useless in the sentence it appears in.
 *
 * Null when nothing qualifies, so the caller decides whether that is worth
 * failing on.
 */
export function cheapestOffered<T extends Offered>(plans: readonly T[]): T | null {
  const candidates = plans
    .filter((p) => p.available && p.selfServe && p.chfMonthly > 0)
    .sort((a, b) => a.chfMonthly - b.chfMonthly);
  return candidates[0] ?? null;
}

export interface SeatState {
  teamId: string;
  tier: PlanTier;
  seats: number;
  /** Seats past the plan's allowance — the quantity Stripe charges. */
  billable: number;
  subscriptionId: string | null;
  /** What Stripe is billing, as last recorded. Null means no seat line item
   *  exists yet: an older subscription, or a flat-priced tier. */
  billedQuantity: number | null;
}

/**
 * How far the billed quantity is from the truth, and in which direction.
 *
 * Both directions matter, and not equally. Undercharging is silent and
 * compounds on exactly the accounts that grew; overcharging is loud, arrives as
 * a complaint, and costs trust. The reconciler acts on either.
 *
 * A team with no subscription is never drifted — an evaluation team has members
 * but nothing to bill, and reporting drift for it would have the reconciler
 * chasing teams it can do nothing about forever.
 */
export function seatDrift(state: SeatState): number {
  if (!state.subscriptionId) return 0;
  return state.billable - (state.billedQuantity ?? 0);
}
