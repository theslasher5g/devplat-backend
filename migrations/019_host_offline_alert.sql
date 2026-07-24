-- Dedup key for host-offline ops alerts: set when we alert that a host went
-- offline, cleared the moment it reports healthy again. NULL means "no open
-- offline alert", so a fresh outage re-alerts while a persistent one does not
-- spam every poll tick.
ALTER TABLE hosts ADD COLUMN offline_alerted_at timestamptz;
