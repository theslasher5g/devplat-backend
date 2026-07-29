-- Measured host usage, alongside the committed figures that already exist.
--
-- hosts.cpu_used / ram_used_mb are the sum of what running VMs' plans promised.
-- That is the right number to admit against — it is what must be honourable if
-- every guest peaks at once — but it says nothing about what the hardware is
-- doing, and it cannot move when load does. Deciding how far to oversubscribe
-- from it would be deciding from a number that is, by construction, blind to
-- the thing being decided.
--
-- So: two sets of columns, two purposes, never conflated. The committed ones
-- stay the hard admission ceiling. These measured ones exist to size an
-- overcommit factor from evidence, and later to order placement by real load.
--
-- EVERY COLUMN HERE IS NULLABLE, AND THAT IS LOAD-BEARING. NULL means "this
-- host's agent does not report it" — an agent predating this change, or one
-- whose guests have not answered yet. If a reader treated NULL as 0, an
-- unmeasured host would look completely idle and attract every new VM on the
-- fleet. Readers must fall back to the committed figures for such a host, not
-- assume the best about it.
ALTER TABLE hosts
  -- Sum of plan promises, as reported by the agent. Redundant with cpu_used /
  -- ram_used_mb (which the scheduler also maintains optimistically at
  -- assign/release), and kept anyway: a disagreement between the two is itself
  -- the signal that the scheduler's bookkeeping has drifted from the host's.
  ADD COLUMN IF NOT EXISTS ram_committed_mb integer,
  -- What guests can touch right now: committed minus what the balloons hold
  -- back. Equals committed while ballooning is in measure-only mode.
  ADD COLUMN IF NOT EXISTS ram_granted_mb integer,
  -- What the guests report actually using. The gap to ram_committed_mb is the
  -- entire opportunity an overcommit factor would spend.
  ADD COLUMN IF NOT EXISTS ram_guest_used_mb integer,
  -- The host's own MemAvailable. Not derivable from the guests: it also
  -- reflects host page cache, the agent, and the registry mirror, all of which
  -- compete for the same physical memory as the next VM. This is the number
  -- that must never approach zero under overcommit.
  ADD COLUMN IF NOT EXISTS ram_host_available_mb integer,

  -- Host-wide non-idle CPU share, excluding iowait.
  ADD COLUMN IF NOT EXISTS cpu_busy_pct integer,
  -- Sum of CPU actually consumed across VMs, in vCPU equivalents. Fractional:
  -- a 4-vCPU VM genuinely using a third of one core is 0.33, and rounding that
  -- to an integer would erase exactly the headroom being measured.
  ADD COLUMN IF NOT EXISTS cpu_used_actual numeric(8,2),
  -- VMs that hit their cpu.max quota in the last sampling window — i.e. builds
  -- slowed by our cap rather than by their own code.
  ADD COLUMN IF NOT EXISTS cpu_throttled_vms integer,

  -- When the measurements above were last refreshed. Staleness matters as much
  -- as absence: a host whose agent died an hour ago still has its last numbers
  -- in these columns, and placing against them would be placing against
  -- history. Readers must treat stale as unmeasured.
  ADD COLUMN IF NOT EXISTS usage_reported_at timestamptz;
