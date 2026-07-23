-- Persist the auto-derived component status over time, so the status page's
-- daily bars reflect real past outages -- not just admin-posted incidents.
--
-- Before this, componentHistories derived the daily bars purely from
-- status_posts. A compute outage detected from hosts.status (all hosts down)
-- that recovered on its own, without anyone posting an incident, left NO
-- trace: the history showed all-green. This table is the missing record.
--
-- It's a transition log, not a per-poll snapshot: the health poller records a
-- row only when a component's effective (derived/manual) status CHANGES. A
-- component's status at any instant is the status of its most recent event at
-- or before that instant (operational if it has no events yet). That keeps
-- the table tiny -- status rarely changes -- while letting the history code
-- reconstruct exactly which days were impaired and for how long.
--
-- Incidents stay in status_posts; componentHistories unions both sources, so
-- an outage that was BOTH auto-detected and posted as an incident is counted
-- once, not twice.

CREATE TABLE status_component_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- References status_components.key logically (free-form, not FK'd, to match
  -- how status_posts.affected_components stays decoupled from the components
  -- table and survives a component being renamed/removed).
  component_key text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- The history query walks events per component within a time window, newest
-- first when it needs the "status active at window start".
CREATE INDEX status_component_events_key_time_idx
  ON status_component_events (component_key, changed_at DESC);
