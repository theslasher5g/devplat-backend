-- Outcome of each backup run, reported by deploy/backup/backup.sh.
--
-- The table exists for one reason: a backup job that silently stopped working
-- is indistinguishable from one that works, right up until the moment you need
-- the data. Recording every run lets the admin dashboard show freshness and
-- lets the maintenance sweep alert when the reports go quiet.
CREATE TABLE IF NOT EXISTS backup_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status           text NOT NULL CHECK (status IN ('ok', 'failed', 'verified')),
  archive          text,
  bytes            bigint NOT NULL DEFAULT 0,
  duration_seconds integer NOT NULL DEFAULT 0,
  detail           text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_runs_created_at_idx ON backup_runs (created_at DESC);

-- Single-row table for platform state that isn't tied to a team or a user.
-- backup_alerted_at records when we last warned that backups went quiet, so
-- the alert fires once per outage rather than once per sweep; a successful
-- report clears it, which re-arms the alert for the next outage.
CREATE TABLE IF NOT EXISTS platform_settings (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  backup_alerted_at timestamptz
);

INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
