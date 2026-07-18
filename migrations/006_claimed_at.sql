-- Tracks exactly when a row was claimed (queued -> assigning) so a stale
-- claim can be detected and reverted on a timer, independent of whether
-- tryAssign()'s own revert-on-failure code ever got to run — it won't if
-- the whole process dies or restarts mid-claim (observed in production:
-- a backend restart during an in-flight tryAssign() left two rows stuck
-- in 'assigning' forever, since the queue worker only ever retries rows
-- with status = 'queued').
ALTER TABLE environment_requests ADD COLUMN claimed_at timestamptz;
