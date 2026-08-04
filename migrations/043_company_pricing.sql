-- Repositioning: from individual developers to companies.
--
-- The old ladder (Free 0 / Solo 19 / Team 79 / Scale 249) sold to a person who
-- wanted a Docker Desktop replacement. That person can use colima for nothing,
-- and the competitor on that ground is Testcontainers Cloud, which Docker owns.
-- The customer this platform is actually equipped for is a company that has to
-- answer where its test data runs: the audit log, SSO, 2FA enforcement, IP
-- allowlists, GDPR export and a three-name sub-processor list were all built
-- for a procurement conversation nobody was being invited to.
--
-- Two structural changes, not just new numbers:
--
--   1. Seats. The old model capped revenue at 249/month no matter how large the
--      customer — a forty-person team paid exactly what an eight-person one did.
--      A base price plus a per-seat price makes revenue grow with the account,
--      which is the difference between a business with a ceiling and one without.
--
--   2. A tier with no published price. The top of the range is now sales-led:
--      it forces the conversation that tells us what a regulated customer will
--      actually pay, which is the number nobody currently knows.
--
-- Tier IDs are deliberately NOT renamed. teams.plan_tier is a foreign key with
-- historical rows behind it, plan_override has a CHECK on the same values, and
-- config.stripePrices is keyed by them. Renaming would be a data migration with
-- nothing to show for it; what each tier MEANS changes instead.
--
-- THE PRICES BELOW ARE A HYPOTHESIS. They were not derived from a single
-- customer conversation, because none have happened yet. Treat them as a
-- starting point to be corrected by the first five calls, not as a finding.

-- Base price stays in price_chf_monthly; this is what each additional seat adds.
-- Zero on tiers that do not charge per seat (evaluation, and the sales-led tier
-- whose price is agreed rather than computed).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_chf_per_seat_monthly numeric(10,2) NOT NULL DEFAULT 0;

-- Seats included before per-seat charging starts. A team of three on a plan with
-- 3 included seats pays the base and nothing more; the fourth person costs a
-- seat. Without this the base price and the per-seat price would double-charge
-- the first users.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS included_seats integer NOT NULL DEFAULT 1;

-- Whether this tier can still be bought. Retiring a tier is not deleting it:
-- teams.plan_tier references plans(id), and any team ever on it — plus every
-- historical subscription row — still needs the row to resolve. `available`
-- says "not offered any more" without rewriting history.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true;

-- Whether a customer can buy it themselves. False means the pricing page shows
-- "contact us" and checkout refuses — the subscription is created by hand after
-- a conversation. This is the flag that stops the top tier from being a ceiling.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS self_serve boolean NOT NULL DEFAULT true;

-- --- Evaluation (was: Free Trial) -----------------------------------------
-- Still 14 days, still self-serve. Enterprise buyers evaluate before they talk;
-- removing the trial to force a sales call would cost more deals than it starts.
-- Two seats rather than one: evaluating a team tool alone is not an evaluation.
UPDATE plans SET
  name = 'Evaluation',
  max_members = 2,
  included_seats = 2
WHERE id = 'free';

-- --- Solo: retired ---------------------------------------------------------
-- Nobody ever bought it, and it is the tier that said "this is for one
-- developer" — the exact message the repositioning removes. Kept resolvable,
-- no longer offered.
UPDATE plans SET available = false, self_serve = false WHERE id = 'solo';

-- --- Team: the company plan ------------------------------------------------
-- Base plus seats. 5 parallel environments covers a normal CI matrix; the audit
-- log moves down to this tier because a plan sold to a company without one is a
-- plan that fails the first security review it meets.
UPDATE plans SET
  name = 'Team',
  price_chf_monthly = 190,
  price_chf_per_seat_monthly = 25,
  included_seats = 5,
  max_members = 25,
  max_parallel_environments = 5,
  audit_log = true
WHERE id = 'team';

-- --- Enterprise (was: Scale) -----------------------------------------------
-- No published price, no self-serve checkout. price_chf_monthly is left at its
-- old value purely so existing rows and the admin view keep resolving a number;
-- nothing charges from it while self_serve is false.
UPDATE plans SET
  name = 'Enterprise',
  self_serve = false,
  max_members = NULL,
  max_parallel_environments = 12
WHERE id = 'scale';

-- --- Seat quantity on the subscription --------------------------------------
-- What Stripe is currently billing, as far as we know. Recorded rather than
-- asked for on every read: the reconciler needs to spot drift without an API
-- call per team, and the invoice a customer disputes is answered from here.
--
-- Nullable, and null is meaningful: it marks a subscription created before seat
-- pricing existed, or one on a flat-priced tier. Zero would say "billing no
-- seats", which is a different and wrong claim.
--
-- The seat line item's id is stored alongside because updating a quantity in
-- Stripe addresses the item, not the subscription — and a subscription with a
-- base price and a seat price has two items, only one of which may be touched.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seat_quantity integer;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seat_item_id text;
-- When the quantity was last pushed successfully. A team whose sync has been
-- failing shows up here as a stale timestamp rather than as silence.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seat_synced_at timestamptz;

-- --- Enterprise enquiries --------------------------------------------------
-- The top tier has no checkout, so it needs somewhere for the conversation to
-- start. Deliberately a table and not just an email: an enquiry that exists only
-- in an inbox is one that gets lost, and the whole point of the sales-led tier
-- is to learn what these customers ask for.
CREATE TABLE IF NOT EXISTS enterprise_enquiries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: the most valuable enquiries come from people who have not signed
  -- up yet, and demanding an account first would lose exactly those.
  team_id       uuid REFERENCES teams(id) ON DELETE SET NULL,
  email         text NOT NULL,
  company       text NOT NULL,
  team_size     integer,
  -- Free text: what they actually need. This is the field worth reading.
  message       text,
  -- Where it came from, so the pricing page and the dashboard can be told apart.
  source        text NOT NULL DEFAULT 'pricing',
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'won', 'lost')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  handled_at    timestamptz
);

-- The admin view's only query: newest first, unhandled first.
CREATE INDEX IF NOT EXISTS enterprise_enquiries_new_idx
  ON enterprise_enquiries (created_at DESC)
  WHERE status = 'new';
