-- Per-team environment TTL, with plan-based defaults and ceilings.
--
-- The TTL was a single hardcoded 60 minutes for everyone (allocator's
-- DEFAULT_TTL_MINUTES). That is simultaneously too generous for a free trial —
-- an abandoned session parks a slot for an hour — and too short for a long
-- integration suite on a paid plan, with no way to say so.
--
-- Two columns per plan: the default a team gets, and the ceiling they may
-- raise it to. Where default = max the value is effectively fixed, which is
-- how the entry tiers are expressed rather than with a separate "may
-- configure" flag.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS ttl_default_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS ttl_max_minutes     integer NOT NULL DEFAULT 60;

--                         default  max
UPDATE plans SET ttl_default_minutes = 15,  ttl_max_minutes = 15  WHERE id = 'free';
UPDATE plans SET ttl_default_minutes = 30,  ttl_max_minutes = 30  WHERE id = 'solo';
UPDATE plans SET ttl_default_minutes = 40,  ttl_max_minutes = 60  WHERE id = 'team';
UPDATE plans SET ttl_default_minutes = 40,  ttl_max_minutes = 120 WHERE id = 'scale';

-- NULL means "whatever the plan says". Storing the override rather than the
-- resolved value means a plan change (or a change to these numbers) takes
-- effect immediately, and a team that downgrades is clamped by the new plan's
-- ceiling instead of silently keeping a value it no longer qualifies for.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS environment_ttl_minutes integer;

ALTER TABLE teams
  ADD CONSTRAINT teams_environment_ttl_sane
  CHECK (environment_ttl_minutes IS NULL OR (environment_ttl_minutes BETWEEN 5 AND 120));

-- The TTL that actually applied is worth keeping per run: it explains why a
-- given environment was torn down when it was, months later, even if the
-- team's setting has changed since.
ALTER TABLE environment_requests
  ADD COLUMN IF NOT EXISTS ttl_minutes integer;
