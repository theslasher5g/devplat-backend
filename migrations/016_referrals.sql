-- Referral programme: a team shares its code; when a team that signed up with
-- it becomes a paying customer, BOTH teams get a free month (a Stripe coupon).
--
-- referral_code lives on the team (generated lazily the first time the team
-- opens the referral card). referrals records the link and its reward state,
-- with a UNIQUE on referred_team_id so a team can only ever be referred once
-- and rewarded once.

ALTER TABLE teams ADD COLUMN referral_code text UNIQUE;

CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- One referral per referred team, ever.
  referred_team_id uuid NOT NULL UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz,
  -- Guard against a team referring itself.
  CHECK (referrer_team_id <> referred_team_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_team_id);
