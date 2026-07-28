-- Application errors, grouped by fingerprint.
--
-- Before this, a 500 went to console.error and into the container log, which
-- means you found out about it when a customer wrote in. Grouping by
-- fingerprint rather than storing every occurrence is what makes it usable: a
-- crash loop is one row with a count, not ten thousand rows.
CREATE TABLE IF NOT EXISTS error_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 of (source, normalized message, top stack frame, route).
  fingerprint   text NOT NULL UNIQUE,
  source        text NOT NULL CHECK (source IN ('api', 'client')),
  message       text NOT NULL,
  stack         text,
  -- Route pattern (/environments/:id), never the concrete URL — a raw path
  -- can carry ids and tokens, and the pattern is what groups usefully anyway.
  route         text,
  method        text,
  status_code   integer,
  count         integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when someone marks it handled. A later occurrence clears it, so a
  -- "fixed" error that comes back re-opens and re-alerts instead of hiding.
  resolved_at   timestamptz,
  -- When ops was last told about this fingerprint, so a recurring error
  -- doesn't mail on every single occurrence.
  alerted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS error_events_last_seen_idx ON error_events (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS error_events_unresolved_idx ON error_events (last_seen_at DESC) WHERE resolved_at IS NULL;
