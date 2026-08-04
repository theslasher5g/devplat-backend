import { maybeOne, one } from '../db.js';
import { getPlan } from '../plans.js';
import { billableSeats, type SeatState } from './pricing.js';
import type { PlanTier } from '../config.js';

/**
 * Keeping the seat count Stripe bills for in step with the people actually in
 * the team.
 *
 * This is the part of seat-based pricing that goes quietly wrong. Adding a
 * colleague and charging for them are two different writes to two different
 * systems, and every design that hopes they stay together is a design that
 * eventually undercharges — usually in the customer's favour, silently, for
 * months, on the accounts that grew the most.
 *
 * Three rules follow from that, and they are the whole design:
 *
 *  1. Membership is the source of truth, never a counter. Every sync recounts
 *     from team_members. An incremented column would drift the first time a
 *     removal raced an invite acceptance, and drift in a billing quantity is
 *     not self-correcting.
 *
 *  2. A failed sync must never fail the request that caused it. Refusing to
 *     remove a member because Stripe timed out is worse than billing one seat
 *     too many for an hour — the removal may be someone revoking a leaver's
 *     access.
 *
 *  3. Because of (2), something has to catch what (2) drops. That is the
 *     reconciler in scheduler/seatSync.ts. This module is the fast path; the
 *     reconciler is the one that makes the invoice right.
 */

/** How many people the team currently has. Pending invites deliberately do not
 *  count: an invitation is not a seat until someone accepts it, and billing for
 *  unaccepted invites is the kind of surprise that ends up in a support thread.
 *  (The seat *cap* does count them — see routes/teams.ts — because a cap is
 *  about reserving room, not about charging.) */
export async function currentSeats(teamId: string): Promise<number> {
  const row = await one<{ count: string }>(
    'SELECT count(*) FROM team_members WHERE team_id = $1', [teamId],
  );
  return Number(row.count);
}

/** Everything a sync decision needs, read in one place so the fast path and the
 *  reconciler cannot disagree about what "current" means. */
export async function seatState(teamId: string): Promise<SeatState | null> {
  const row = await maybeOne<{
    plan_tier: PlanTier; seats: string;
    stripe_subscription_id: string | null; seat_quantity: number | null;
  }>(
    `SELECT COALESCE(t.plan_override, t.plan_tier) AS plan_tier,
            (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) AS seats,
            s.stripe_subscription_id, s.seat_quantity
     FROM teams t
     LEFT JOIN subscriptions s ON s.team_id = t.id
     WHERE t.id = $1`,
    [teamId],
  );
  if (!row) return null;
  const plan = getPlan(row.plan_tier);
  const seats = Number(row.seats);
  return {
    teamId,
    tier: row.plan_tier,
    seats,
    billable: billableSeats(plan, seats),
    subscriptionId: row.stripe_subscription_id,
    billedQuantity: row.seat_quantity,
  };
}

export { seatDrift, type SeatState } from './pricing.js';
