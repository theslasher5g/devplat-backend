-- Plans as data, not hardcoded application logic. Each tier now carries a
-- per-environment resource cap (vCPU + RAM) in addition to the parallel-
-- environment count — previously a tier only bounded HOW MANY environments a
-- team could run, never how large each one could get, so a single microVM
-- (Kafka + Elasticsearch + Oracle + the app under test) could pull unbounded
-- resources. The scheduler now reads vcpu_per_environment / ram_gb_per_environment
-- from here and passes them to the agent as the VM's hard cgroup/Firecracker
-- limits (see src/scheduler/allocator.ts, devplat-agent's manager.Create).
--
-- id matches the existing teams.plan_tier string values ('free'/'solo'/'team'/
-- 'scale'), so the FK below is additive on top of the CHECK constraint already
-- on teams.plan_tier. Max RAM footprint per tier is intentionally NOT stored —
-- it's derivable (max_parallel_environments * ram_gb_per_environment) and
-- storing it would be redundant state that could drift.
CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  price_chf_monthly integer NOT NULL,
  max_parallel_environments integer NOT NULL,
  vcpu_per_environment integer NOT NULL,
  ram_gb_per_environment integer NOT NULL,
  trial_duration_days integer -- nullable: only Free Trial is time-boxed
);

INSERT INTO plans
  (id, name, price_chf_monthly, max_parallel_environments, vcpu_per_environment, ram_gb_per_environment, trial_duration_days)
VALUES
  ('free',  'Free Trial', 0,   1, 1,  2, 14),
  ('solo',  'Solo',       19,  2, 2,  4, NULL),
  ('team',  'Team',       79,  5, 4,  8, NULL),
  ('scale', 'Scale',      249, 8, 6, 12, NULL);

-- teams.plan_tier now references this table. The pre-existing CHECK constraint
-- (migrations/001) already restricts it to the same four values, so every
-- existing row satisfies this FK.
ALTER TABLE teams
  ADD CONSTRAINT teams_plan_tier_fk FOREIGN KEY (plan_tier) REFERENCES plans(id);

-- Record the resource size actually granted to each assigned environment, so
-- release subtracts exactly what assignment added to hosts.cpu_used/ram_used_mb
-- even if the team's plan changed in between. Nullable: queued/failed rows and
-- rows predating this migration have none.
ALTER TABLE environment_requests
  ADD COLUMN vcpu integer,
  ADD COLUMN ram_mb integer;
