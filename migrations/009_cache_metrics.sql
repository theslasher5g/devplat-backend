-- Per-host registry pull-through cache counters, reported by the agent (from
-- the registry's expvar debug endpoint). Cumulative since the cache container
-- started; the admin overview pools them across hosts into a hit rate. NULL
-- means the host hasn't reported cache data (debug endpoint off/unreachable),
-- distinct from a real zero.
ALTER TABLE hosts ADD COLUMN cache_lookups bigint;
ALTER TABLE hosts ADD COLUMN cache_hits bigint;
