-- Graceful draining: an admin can mark a host to stop receiving new VMs while
-- its existing VMs keep running until they're released or hit their TTL — e.g.
-- before maintenance or a decommission.
--
-- Separate from hosts.status (which the health poller owns and overwrites from
-- the agent's own draining flag every tick): a manual admin drain must NOT be
-- clobbered by the next poll, so it lives in its own column the poller never
-- touches. The scheduler's candidate-host query excludes drain = true.
ALTER TABLE hosts ADD COLUMN drain boolean NOT NULL DEFAULT false;
