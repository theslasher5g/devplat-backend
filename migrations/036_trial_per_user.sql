-- The free trial belongs to the person, not to the team.
--
-- POST /teams gave every new team a fresh 14-day trial and capped nothing, so
-- one verified account could mint trials indefinitely. That is not merely "a
-- trial can be extended": the free tier grants one parallel environment per
-- team, so ten teams is ten concurrent environments — more parallelism than the
-- Solo plan it would otherwise cost CHF 19 a month to get. The rate limit of
-- ten creations an hour bounded the speed of the abuse, not the abuse.
--
-- Capping the number of teams alone would only raise the price of the trick.
-- Binding the trial to the user removes the reason to try it: a second team
-- starts already expired and has to pick a plan before it can run anything.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;

-- Backfill, so nobody who has already had a trial silently gets a second one on
-- the next team they create. Owned teams only: being invited into someone
-- else's team is not a trial you consumed, and a member who later starts their
-- own team should still get their one go.
--
-- The earliest owned team's creation date is the closest thing to "when this
-- user's trial started" that the existing data can answer, and it is exactly
-- right for the common case where the first team came from registration.
UPDATE users u
SET trial_started_at = first_owned.created_at
FROM (
  SELECT tm.user_id, min(t.created_at) AS created_at
  FROM team_members tm
  JOIN teams t ON t.id = tm.team_id
  WHERE tm.role = 'owner'
  GROUP BY tm.user_id
) AS first_owned
WHERE first_owned.user_id = u.id
  AND u.trial_started_at IS NULL;
