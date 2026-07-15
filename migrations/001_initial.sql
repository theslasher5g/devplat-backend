CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  stripe_customer_id text UNIQUE,
  plan_tier text NOT NULL DEFAULT 'free'
    CHECK (plan_tier IN ('free', 'solo', 'team', 'scale')),
  trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'developer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  token_prefix text NOT NULL DEFAULT '',
  scope text NOT NULL DEFAULT 'ci:run' CHECK (scope IN ('ci:run', 'dev:run')),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_tokens_team_idx ON api_tokens(team_id);

CREATE TABLE subscriptions (
  team_id uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_price_id text,
  status text NOT NULL,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  type text NOT NULL CHECK (type IN ('verify_email', 'password_reset')),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_tokens_user_idx ON verification_tokens(user_id);

-- Invitations need their own table: the invitee may not have a user account yet.
CREATE TABLE team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'developer' CHECK (role IN ('admin', 'developer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_invites_team_idx ON team_invites(team_id);

-- Data-plane tables: created now so the admin dashboard is built against the
-- real schema; stays sparse until the Firecracker scheduler exists.
CREATE TABLE hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  location text NOT NULL DEFAULT 'CH-ZRH-1',
  cpu_total int NOT NULL DEFAULT 0,
  ram_total_mb int NOT NULL DEFAULT 0,
  cpu_used int NOT NULL DEFAULT 0,
  ram_used_mb int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'draining', 'offline')),
  last_heartbeat timestamptz
);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  host_id uuid REFERENCES hosts(id) ON DELETE SET NULL,
  vm_id text,
  event_type text NOT NULL CHECK (event_type IN ('start', 'stop', 'start_failed')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_team_idx ON usage_events(team_id, occurred_at DESC);
CREATE INDEX usage_events_time_idx ON usage_events(occurred_at DESC);
