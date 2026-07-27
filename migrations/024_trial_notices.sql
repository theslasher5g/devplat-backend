-- Which trial-expiry notice a team has already been sent, so the daily sweep
-- doesn't mail the same owner every run. Stores the milestone (days remaining)
-- rather than a boolean, so the 3-day and the 0-day notice can both go out.
ALTER TABLE teams ADD COLUMN trial_notice_sent_at_days integer;
