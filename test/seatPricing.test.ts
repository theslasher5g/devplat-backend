import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billableSeats, monthlyCost, seatDrift, type Priced, type SeatState } from '../src/lib/pricing.js';

/**
 * Seat pricing is the change that removes the revenue ceiling, which makes it
 * the change most worth getting wrong quietly. The two failure directions are
 * not symmetric: overcharging produces a complaint and a refund, undercharging
 * produces nothing at all until someone reconciles a year of invoices.
 */

function plan(over: Partial<Priced> = {}): Priced {
  return {
    chfMonthly: 190, chfPerSeatMonthly: 25, includedSeats: 5, selfServe: true,
    ...over,
  };
}

test('a team inside its included seats pays the base only', () => {
  assert.equal(billableSeats(plan(), 3), 0);
  assert.equal(monthlyCost(plan(), 3), 190);
  assert.equal(monthlyCost(plan(), 5), 190, 'exactly at the allowance is still base only');
});

test('the first seat past the allowance is the first one charged', () => {
  // The off-by-one that would either give a seat away or charge for one the
  // customer was told was included.
  assert.equal(billableSeats(plan(), 6), 1);
  assert.equal(monthlyCost(plan(), 6), 215);
});

test('revenue grows with the account — the point of the change', () => {
  assert.equal(monthlyCost(plan(), 10), 190 + 5 * 25);
  assert.equal(monthlyCost(plan(), 25), 190 + 20 * 25);
  // The old model charged 249 whatever the size. It now scales — but note how
  // gently, and that is a pricing decision rather than an implementation
  // detail: a base of 190 against a seat of 25 means the base dominates until
  // roughly eight people, so a 25-person customer is worth 2.6x an 8-person
  // one, not the 4x a steeper split would give. Lowering the base and raising
  // the seat price is the lever if that ratio is too flat.
  const small = monthlyCost(plan(), 8)!;   // 265
  const large = monthlyCost(plan(), 25)!;  // 690
  assert.ok(large > 2 * small, `expected meaningful growth, got ${large} vs ${small}`);
  assert.ok(large < 3 * small, 'this split is deliberately gentle — see the note above');
});

test('a team below its allowance never produces a credit', () => {
  // Membership can drop below the included seats when people leave. A negative
  // billable count would turn into money owed to the customer that nobody
  // agreed to.
  assert.equal(billableSeats(plan(), 1), 0);
  assert.equal(billableSeats(plan(), 0), 0);
  assert.equal(monthlyCost(plan(), 0), 190);
});

test('a sales-led tier has no computed price', () => {
  // Inventing a number for a plan whose price is negotiated would put a figure
  // on the pricing page that nobody agreed to charge.
  assert.equal(monthlyCost(plan({ selfServe: false }), 40), null);
});

test('a tier that does not charge per seat is unaffected by headcount', () => {
  const evaluation = plan({ chfMonthly: 0, chfPerSeatMonthly: 0, includedSeats: 2 });
  assert.equal(monthlyCost(evaluation, 2), 0);
  assert.equal(monthlyCost(evaluation, 50), 0);
});

/* ---- drift ---- */

function state(over: Partial<SeatState> = {}): SeatState {
  return {
    teamId: 't', tier: 'team', seats: 8, billable: 3,
    subscriptionId: 'sub_1', billedQuantity: 3, ...over,
  };
}

test('a matching quantity is not drift', () => {
  assert.equal(seatDrift(state()), 0);
});

test('an added member shows as positive drift', () => {
  assert.equal(seatDrift(state({ seats: 9, billable: 4, billedQuantity: 3 })), 1);
});

test('a departed member shows as negative drift', () => {
  // Must be caught too. Billing for someone who left is the complaint that
  // costs trust, even though it is the direction that favours us.
  assert.equal(seatDrift(state({ seats: 7, billable: 2, billedQuantity: 3 })), -1);
});

test('a team with no subscription is never drifted', () => {
  // An evaluation team has members but nothing to bill. Reporting drift for it
  // would make the reconciler chase teams it can do nothing about, forever.
  assert.equal(seatDrift(state({ subscriptionId: null, billable: 5, billedQuantity: null })), 0);
});

test('a subscription that has never been synced counts as drifted', () => {
  // null means "no seat line recorded". Treating it as zero would leave a
  // subscription created before seat pricing silently never charging for seats.
  assert.equal(seatDrift(state({ billable: 3, billedQuantity: null })), 3);
});

test('a synced-at-zero subscription is distinguishable from an unsynced one', () => {
  assert.equal(seatDrift(state({ billable: 0, billedQuantity: 0 })), 0);
  assert.equal(seatDrift(state({ billable: 0, billedQuantity: null })), 0,
    'zero billable and never synced still needs no change');
});
