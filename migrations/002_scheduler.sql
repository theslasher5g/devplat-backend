-- Host-pool + scheduler support: each host runs a devplat-agent reachable
-- only over the WireGuard tunnel (agent_endpoint), authenticated with a
-- per-host shared-secret token used in BOTH directions — the scheduler sends
-- it to the agent on every VM-lifecycle call, and the agent sends it back on
-- every heartbeat. Unlike api_tokens/passwords, the backend must be able to
-- present the plaintext to authenticate outbound, so this can't be a
-- hash-once credential; it's stored the same way STRIPE_SECRET_KEY is — a
-- server-only secret, never returned by any GET endpoint.
ALTER TABLE hosts
  ADD COLUMN agent_endpoint text,
  ADD COLUMN agent_token text UNIQUE,
  ADD COLUMN wireguard_ip text;

-- Where a running environment's Docker API can be reached, and the request
-- that produced it. Nullable: 'stop' events don't set it, and events
-- predating this migration have none.
ALTER TABLE usage_events
  ADD COLUMN docker_endpoint text,
  ADD COLUMN request_id uuid;

-- Queue for environment requests. A request is inserted immediately on
-- arrival; if capacity is free it's assigned synchronously in the same call,
-- otherwise it sits as 'queued' until the background worker assigns it as
-- capacity frees up (see src/scheduler/queueWorker.ts). This makes the queue
-- durable across scheduler restarts and gives the (future) client CLI a
-- request id to poll.
CREATE TABLE environment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'assigned', 'failed', 'released')),
  host_id uuid REFERENCES hosts(id) ON DELETE SET NULL,
  vm_id text,
  docker_endpoint text,
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  released_at timestamptz
);
CREATE INDEX environment_requests_team_idx ON environment_requests(team_id);
-- Queue worker scans oldest-first among 'queued' rows.
CREATE INDEX environment_requests_queue_idx ON environment_requests(requested_at)
  WHERE status = 'queued';

ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_request_fk FOREIGN KEY (request_id)
    REFERENCES environment_requests(id) ON DELETE SET NULL;
