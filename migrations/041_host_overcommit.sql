-- Overcommit settings and their consequences, per host.
--
-- Two columns that answer the only question that matters once a host is
-- promising more memory than it has: is it getting away with it?
--
--   overcommit_pct  what the host is configured to promise, as a percentage of
--                   its physical RAM. 100 (or NULL, for an agent that predates
--                   this) means it promises only what it has.
--   starved_grants  how many times a guest under memory pressure could not be
--                   given memory it had already been promised.
--
-- The second is the whole point. An overcommit ratio set too high does not
-- announce itself: nothing crashes, no alert fires, a customer's build merely
-- takes longer and nobody connects that to a number set on a host months ago.
-- Counting the moment a promise could not be kept turns an invisible cost into
-- a readable one — and if this column is above zero on a host, that host's
-- ratio is wrong for what its customers actually do.
--
-- Nullable, like every other measured column on this table (see migration 035):
-- an agent that does not report these must stay distinguishable from one
-- reporting a genuine zero, because "never starved anyone" and "we have no idea"
-- justify opposite decisions.
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS overcommit_pct integer;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS starved_grants bigint;

-- The counter is cumulative for the life of an agent process, so it resets on
-- restart. Recording when it was last seen to increase is what separates "this
-- host starved someone during a load spike last month" from "this host is
-- starving guests right now".
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS starved_grants_at timestamptz;
