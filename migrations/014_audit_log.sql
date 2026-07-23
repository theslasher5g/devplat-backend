-- Audit log: who did what, for team admins (their own team's activity) and
-- platform admins (everything). Actor email is denormalised so a record
-- survives the actor's user row being deleted.
--
-- team_id is nullable and NOT cascade-critical for platform actions: a
-- platform admin deleting a team records the event with team_id = NULL and the
-- team's name in `target`, so the audit of the deletion isn't itself deleted by
-- the team's ON DELETE CASCADE. Team-scoped events (token created, member
-- invited, …) set team_id and are fine to disappear with the team.

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email text,
  -- Dotted action key, e.g. 'token.create', 'member.invite', 'plan.override'.
  action text NOT NULL,
  -- Human-readable subject of the action (a token label, an email, a tier).
  target text,
  -- Any extra structured context (old/new values, ids).
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_team_idx ON audit_log (team_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
