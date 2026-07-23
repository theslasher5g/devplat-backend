import { randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { stripe } from './stripe.js';

// Deterministic coupon id so we reuse one coupon rather than creating a new
// one per reward. 100% off for a single billing cycle = "one free month".
const REFERRAL_COUPON_ID = 'devplat_referral_1mo';

/** Return a team's referral code, generating and persisting one on first use.
 *  Codes are short, unambiguous, and retried on the (astronomically unlikely)
 *  unique-collision. */
export async function getOrCreateReferralCode(teamId: string): Promise<string> {
  const existing = await query<{ referral_code: string | null }>('SELECT referral_code FROM teams WHERE id = $1', [teamId]);
  if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8).toUpperCase();
    try {
      const res = await query<{ referral_code: string }>(
        'UPDATE teams SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL RETURNING referral_code',
        [code, teamId],
      );
      if (res.rows[0]) return res.rows[0].referral_code;
      // Someone set it concurrently — read it back.
      const now = await query<{ referral_code: string | null }>('SELECT referral_code FROM teams WHERE id = $1', [teamId]);
      if (now.rows[0]?.referral_code) return now.rows[0].referral_code;
    } catch {
      // Unique collision on the code itself — loop and try another.
    }
  }
  throw new Error('could not allocate a referral code');
}

/** Record that `referredTeamId` signed up via `code`, if the code is valid and
 *  the team isn't referring itself. Idempotent via the UNIQUE(referred_team_id):
 *  a duplicate insert is swallowed. Called from registration. */
export async function linkReferral(code: string, referredTeamId: string): Promise<void> {
  const referrer = await query<{ id: string }>('SELECT id FROM teams WHERE referral_code = $1', [code.trim().toUpperCase()]);
  const referrerTeamId = referrer.rows[0]?.id;
  if (!referrerTeamId || referrerTeamId === referredTeamId) return;
  try {
    await query(
      "INSERT INTO referrals (referrer_team_id, referred_team_id) VALUES ($1, $2) ON CONFLICT (referred_team_id) DO NOTHING",
      [referrerTeamId, referredTeamId],
    );
  } catch (err) {
    console.error('[referral] failed to link', err);
  }
}

async function ensureCoupon(): Promise<string | null> {
  if (!stripe) return null;
  try {
    await stripe.coupons.retrieve(REFERRAL_COUPON_ID);
  } catch {
    // Doesn't exist yet — create it once.
    try {
      await stripe.coupons.create({ id: REFERRAL_COUPON_ID, percent_off: 100, duration: 'once', name: 'devplat referral — 1 month free' });
    } catch (err) {
      console.error('[referral] failed to create coupon', err);
      return null;
    }
  }
  return REFERRAL_COUPON_ID;
}

/** Apply the referral coupon to a team: to its active subscription if it has
 *  one, else to its Stripe customer so it lands on the team's first paid
 *  invoice. Best-effort per team. */
async function grantFreeMonth(teamId: string, coupon: string): Promise<void> {
  if (!stripe) return;
  const row = await query<{ stripe_customer_id: string | null; sub_id: string | null; status: string | null }>(
    `SELECT t.stripe_customer_id, s.stripe_subscription_id AS sub_id, s.status
       FROM teams t LEFT JOIN subscriptions s ON s.team_id = t.id WHERE t.id = $1`,
    [teamId],
  );
  const info = row.rows[0];
  if (!info) return;
  try {
    if (info.sub_id && info.status && ['active', 'trialing', 'past_due'].includes(info.status)) {
      await stripe.subscriptions.update(info.sub_id, { coupon });
    } else if (info.stripe_customer_id) {
      await stripe.customers.update(info.stripe_customer_id, { coupon });
    }
  } catch (err) {
    console.error('[referral] failed to grant free month to team', teamId, err);
  }
}

/** Called when `referredTeamId` becomes a paying customer. If it has a pending
 *  referral, reward both teams with a free month and mark it rewarded. Marks
 *  rewarded only after the (best-effort) Stripe grants so a Stripe outage
 *  leaves it retryable. No-op when Stripe isn't configured. */
export async function rewardReferralOnSubscription(referredTeamId: string): Promise<void> {
  const ref = await query<{ id: string; referrer_team_id: string }>(
    "SELECT id, referrer_team_id FROM referrals WHERE referred_team_id = $1 AND status = 'pending'",
    [referredTeamId],
  );
  const referral = ref.rows[0];
  if (!referral) return;
  const coupon = await ensureCoupon();
  if (!coupon) return; // Stripe not configured — leave pending for a later retry.
  await grantFreeMonth(referredTeamId, coupon);
  await grantFreeMonth(referral.referrer_team_id, coupon);
  await query("UPDATE referrals SET status = 'rewarded', rewarded_at = now() WHERE id = $1", [referral.id]);
}
