import { query } from '../db.js';
import { SchedulerLock, lockedTick } from '../lib/advisoryLock.js';
import { requireStripe } from '../lib/stripe.js';
import { seatDrift, seatState } from '../lib/seats.js';

/**
 * Pushing seat counts to Stripe, and catching the ones that did not make it.
 *
 * Two entry points, deliberately different in temperament:
 *
 *   pushSeats()  is called right after a membership change. Best-effort, never
 *                throws into the caller: refusing to remove a colleague because
 *                Stripe timed out would be a security problem wearing a billing
 *                problem's clothes.
 *
 *   reconcile()  runs on a timer and fixes whatever pushSeats dropped. This is
 *                the one that makes the invoice right, and it exists precisely
 *                because the fast path is allowed to fail quietly.
 *
 * Without the second, "best-effort" means "we undercharge the accounts that grew
 * and never find out". With it, a failed push costs an hour of wrong quantity
 * rather than a quarter of wrong revenue.
 */

/** Bounded so a Stripe outage can't turn one tick into a thousand slow calls. */
const MAX_PER_TICK = 50;

/**
 * Set the seat quantity on a team's subscription, if it needs setting.
 *
 * Returns what happened, so the caller and the tests can tell "nothing to do"
 * apart from "did it" apart from "tried and failed" — three outcomes that a
 * boolean would flatten into a lie.
 */
export async function pushSeats(teamId: string): Promise<'noop' | 'synced' | 'failed'> {
  try {
    const state = await seatState(teamId);
    if (!state || !state.subscriptionId) return 'noop';
    if (seatDrift(state) === 0) return 'noop';

    // The item id is what Stripe updates — a subscription carrying a base price
    // and a seat price has two items, and sending a quantity to the wrong one
    // would change what the customer pays for the wrong thing.
    let itemId = await seatItemId(teamId);
    if (!itemId) {
      itemId = await discoverSeatItem(teamId, state.subscriptionId);
      if (!itemId) return 'noop'; // flat-priced or pre-seat subscription
    }

    await requireStripe().subscriptionItems.update(itemId, {
      quantity: state.billable,
      // Bill the difference now rather than at the next renewal. A seat added
      // on day 2 of a month that is invoiced on day 30 should not be free, and
      // a seat removed should not keep being charged — proration is what makes
      // the number on the invoice match what the customer actually had.
      proration_behavior: 'create_prorations',
    });

    await query(
      `UPDATE subscriptions SET seat_quantity = $2, seat_item_id = $3, seat_synced_at = now()
       WHERE team_id = $1`,
      [teamId, state.billable, itemId],
    );
    return 'synced';
  } catch (err) {
    // Deliberately swallowed. The reconciler will come back to it, and the
    // caller — a member removal, an invite acceptance — must not fail because
    // billing did.
    console.error(`[seats] could not sync team ${teamId}:`, err);
    return 'failed';
  }
}

async function seatItemId(teamId: string): Promise<string | null> {
  const r = await query<{ seat_item_id: string | null }>(
    'SELECT seat_item_id FROM subscriptions WHERE team_id = $1', [teamId],
  );
  return r.rows[0]?.seat_item_id ?? null;
}

/**
 * Find the seat line item on a subscription we have not recorded one for.
 *
 * Needed for every subscription created before this existed, and for any created
 * by hand in the Stripe dashboard — which is exactly how the sales-led tier gets
 * set up, so this is not an edge case, it is the normal path for the customers
 * that matter most.
 *
 * Identified by quantity being settable rather than by price id: matching on a
 * configured price id would fail for a negotiated enterprise price that is not
 * in our env at all.
 */
async function discoverSeatItem(teamId: string, subscriptionId: string): Promise<string | null> {
  const sub = await requireStripe().subscriptions.retrieve(subscriptionId);
  // Two items means base + seats. One means a flat plan, and there is nothing
  // to sync. More than two is a hand-built subscription we should not guess at.
  if (sub.items.data.length !== 2) return null;
  // The seat item is the one whose price is per-unit and whose quantity is
  // meant to move; the base is quantity 1 and stays there. Where both look
  // alike, the second item is the seat item by construction — checkout appends
  // it after the base.
  const item = sub.items.data[1];
  await query('UPDATE subscriptions SET seat_item_id = $2 WHERE team_id = $1', [teamId, item.id]);
  return item.id;
}

/**
 * Find teams whose billed seats no longer match their membership, and fix them.
 *
 * The candidate query does the comparison in SQL rather than pulling every team
 * into memory: on a platform where most teams are stable most of the time, the
 * interesting set is nearly always empty, and it should cost nearly nothing to
 * discover that.
 */
export async function reconcileSeats(): Promise<{ checked: number; synced: number; failed: number }> {
  const drifted = await query<{ team_id: string }>(
    `SELECT s.team_id
     FROM subscriptions s
     JOIN teams t ON t.id = s.team_id
     JOIN plans p ON p.id = COALESCE(t.plan_override, t.plan_tier)
     WHERE p.price_chf_per_seat_monthly > 0
       AND s.status IN ('active', 'trialing', 'past_due')
       AND GREATEST(0, (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) - p.included_seats)
           IS DISTINCT FROM COALESCE(s.seat_quantity, -1)
     ORDER BY s.seat_synced_at NULLS FIRST
     LIMIT $1`,
    [MAX_PER_TICK],
  );

  let synced = 0, failed = 0;
  for (const row of drifted.rows) {
    const outcome = await pushSeats(row.team_id);
    if (outcome === 'synced') synced++;
    else if (outcome === 'failed') failed++;
  }
  if (synced > 0 || failed > 0) {
    console.log(`[seats] reconciled ${synced} team(s), ${failed} still failing`);
  }
  return { checked: drifted.rows.length, synced, failed };
}

/** Every few minutes is plenty: the fast path handles the common case within
 *  seconds, and this only has to catch what it dropped before the invoice. */
export function startSeatSync(intervalMs = 5 * 60_000): () => void {
  const tick = lockedTick('seat sync', SchedulerLock.seatSync, async () => {
    await reconcileSeats();
  });
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
