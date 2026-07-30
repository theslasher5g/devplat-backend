-- Indexes for the retention sweep added in scheduler/maintenance.ts.
--
-- Without these the daily prune is a sequential scan over the two
-- fastest-growing tables in the schema, to find the handful of rows that aged
-- out since yesterday. That is backwards: the sweep exists to keep these tables
-- small, and it should not have to read all of one to do it.
--
-- Both are plain btrees on the timestamp rather than composites with `status`.
-- The predicate is time-first — old rows are always a small tail — so the scan
-- stops early, and a narrower index costs the write path less on tables that
-- take an insert per webhook event and per environment start.

-- Prune predicate: created_at < cutoff AND status IN ('delivered','failed').
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx
  ON webhook_deliveries (created_at);

-- Prune predicate: requested_at < cutoff AND status IN ('released','failed').
-- environment_requests already has a partial index on requested_at for queued
-- rows only, which is exactly the rows this sweep must never touch.
CREATE INDEX IF NOT EXISTS environment_requests_requested_idx
  ON environment_requests (requested_at);
