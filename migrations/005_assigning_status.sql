-- 'assigning' is a claim state between 'queued' and 'assigned': tryAssign()
-- sets it right before calling the agent's (potentially several-second)
-- createVm(), so a later queue-worker tick can't pick up the same row again
-- while an attempt is still in flight. Without this, a slow createVm() that
-- outlasted one tick interval let two ticks both boot a VM for the same
-- request; only the last one's UPDATE was remembered and the earlier VM was
-- silently orphaned, still running, forever.
ALTER TABLE environment_requests DROP CONSTRAINT environment_requests_status_check;
ALTER TABLE environment_requests
  ADD CONSTRAINT environment_requests_status_check
  CHECK (status IN ('queued', 'assigning', 'assigned', 'failed', 'released'));
