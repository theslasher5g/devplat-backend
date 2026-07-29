-- Outgoing webhooks: team-defined HTTP endpoints notified about their own
-- environment events.
--
-- The dashboard is not where a customer wants to learn that a run failed — they
-- want it in the channel they already watch. Without this, integrating devplat
-- into anything (Slack, an internal deploy bot, a status board) means polling
-- our API on a timer.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  url          text NOT NULL,
  -- Stored in plaintext, unlike api_tokens. It has to be: signing is HMAC, so
  -- the sender needs the same bytes the receiver has, and a hash can't produce
  -- them. It is a shared secret we issue, not a credential that authenticates
  -- anyone to us — the blast radius of a leak is forged webhook payloads to
  -- that one customer's endpoint, not access to their account. Rotatable.
  secret       text NOT NULL,
  -- Event names this endpoint wants. Empty means all of them.
  events       text[] NOT NULL DEFAULT '{}',
  description  text,
  enabled      boolean NOT NULL DEFAULT true,
  -- Set when we auto-disable after sustained failure, so the UI can explain
  -- itself instead of just showing a switch that flipped on its own.
  disabled_reason text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_team_idx ON webhook_endpoints (team_id);

-- One row per (event, endpoint) attempt-set. Deliveries are queued rather than
-- sent inline: a customer endpoint that hangs for 30s must not hold up VM
-- assignment, and a delivery that fails needs to outlive the request that
-- caused it in order to be retried at all.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id  uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  event_id     uuid NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  -- Truncated at the write site. A customer's error page can be megabytes and
  -- none of it past the first few hundred bytes helps anyone debug.
  response_body text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

-- The delivery worker's only query: due rows, oldest first.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';

-- The dashboard's delivery log, newest first per team.
CREATE INDEX IF NOT EXISTS webhook_deliveries_team_idx
  ON webhook_deliveries (team_id, created_at DESC);
