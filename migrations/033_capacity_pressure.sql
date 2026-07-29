-- Capacity pressure: record when a team's own parallelism cap is what made a
-- run wait.
--
-- Parallelism is the entire pricing axis, so "this team is repeatedly at its
-- limit" is the single most valuable signal the system produces — for the
-- customer (their CI is slower than it needs to be) and for us (an upgrade
-- nobody asked for because nobody could see it). Until now it was invisible on
-- both sides: a request that found no free slot simply stayed 'queued', which
-- looks identical to a request waiting for host capacity.
--
-- The unit recorded is the RUN, not the refusal. The queue worker retries every
-- queued row every few seconds, so counting refusals would report a single
-- 20-minute wait as ~240 events. The stamp is therefore set once and never
-- overwritten (COALESCE at the write site), which makes both numbers that
-- matter fall out directly: how many runs had to wait, and — against
-- assigned_at — how long each one waited.
ALTER TABLE environment_requests
  ADD COLUMN IF NOT EXISTS capacity_blocked_at timestamptz;

-- Partial: only a small minority of rows ever carry the stamp, and every read
-- is "this team, recently".
CREATE INDEX IF NOT EXISTS environment_requests_capacity_blocked_idx
  ON environment_requests (team_id, capacity_blocked_at)
  WHERE capacity_blocked_at IS NOT NULL;

-- Dedupe for the owner notice. A team that lives at its limit would otherwise
-- be mailed on every sweep; this holds it to one notice per cooldown window.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS capacity_notice_sent_at timestamptz;
