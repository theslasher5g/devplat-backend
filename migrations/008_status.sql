-- Public status page + admin-posted incidents / maintenance / announcements.
--
-- Two ideas:
--  1. status_components — the rows shown on /status. Each is either derived
--     from a live signal (source='api' or 'compute') or set by hand
--     (source='manual'). For derived components an admin can still pin an
--     override in manual_status (e.g. force 'maintenance' during planned
--     work); null there means "use the derived value".
--  2. status_posts (+ status_post_updates) — the admin's board: incidents,
--     scheduled maintenance, and general announcements, each with a thread of
--     updates over time (the standard status-page pattern).

CREATE TABLE status_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  -- 'api'     : up iff the API is answering (it is, if /status responds)
  -- 'compute' : aggregated from hosts.status
  -- 'manual'  : status is whatever manual_status says
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('api', 'compute', 'manual')),
  -- Override for derived sources, or the value itself for source='manual'.
  -- NULL for a derived component means "show the derived status".
  manual_status text CHECK (manual_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the two auto-derived components. Compute aggregates ALL hosts (the
-- product is single-region today; the migration's location default and the
-- code's differ, so aggregating everything avoids depending on that string).
INSERT INTO status_components (key, name, source, position) VALUES
  ('api', 'API', 'api', 0),
  ('compute', 'Compute · Basel', 'compute', 1);

CREATE TABLE status_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('incident', 'maintenance', 'announcement')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  -- How bad it is, for sorting/coloring the overall banner.
  impact text NOT NULL DEFAULT 'minor'
    CHECK (impact IN ('none', 'minor', 'major', 'critical', 'maintenance')),
  -- Lifecycle. Allowed values differ by type; the route validates the combo.
  --   incident:     investigating | identified | monitoring | resolved
  --   maintenance:  scheduled | in_progress | completed
  --   announcement: published
  state text NOT NULL,
  -- Component keys this post affects (free-form; the UI maps them to names).
  affected_components text[] NOT NULL DEFAULT '{}',
  -- Maintenance window (null for incidents/announcements).
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Set when an incident resolves / maintenance completes; drives whether a
  -- post is "active" (shown at the top) or "history".
  resolved_at timestamptz
);
CREATE INDEX status_posts_active_idx ON status_posts(created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE status_post_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES status_posts(id) ON DELETE CASCADE,
  -- The state the post moved to with this update (null = no state change).
  state text,
  body text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_post_updates_post_idx ON status_post_updates(post_id, created_at);
