-- Multi-team membership, finished.
--
-- team_members has always been a many-to-many table, but every lookup did
-- `ORDER BY created_at LIMIT 1`, so a user invited to a second team silently
-- kept working in their oldest one — no error, no switcher, no way to reach the
-- new team. active_team_id records which membership the user is currently
-- acting in; NULL falls back to the oldest, so existing sessions are unaffected.
--
-- ON DELETE SET NULL: deleting a team must not delete its members' accounts,
-- it just drops them back to the fallback.
ALTER TABLE users
  ADD COLUMN active_team_id uuid REFERENCES teams(id) ON DELETE SET NULL;

-- Seat limits per plan (see migrations/003_plans.sql for the tier rows).
-- NULL = unlimited, which is what the enterprise-ish top tier gets.
ALTER TABLE plans ADD COLUMN max_members integer;

UPDATE plans SET max_members = 1    WHERE id = 'free';
UPDATE plans SET max_members = 1    WHERE id = 'solo';
UPDATE plans SET max_members = 10   WHERE id = 'team';
UPDATE plans SET max_members = NULL WHERE id = 'scale';
