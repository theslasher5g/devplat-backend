-- The audit log becomes a Scale entitlement, matching what the pricing page has
-- always said.
--
-- The pricing table lists "Audit log" as Scale-only, but the API gated it on
-- role alone — every owner and admin on every tier could read and export it.
-- The page was describing a product that didn't exist.
--
-- Kept in the plans table rather than hardcoded, for the same reason as the seat
-- and TTL caps: one place decides what a tier includes, and a pricing change is
-- a row edit rather than a deploy.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS audit_log boolean NOT NULL DEFAULT false;

UPDATE plans SET audit_log = true  WHERE id = 'scale';
-- Restated rather than left to the default, so this migration fully describes
-- the intended state instead of depending on what the column default happened
-- to be when it was added.
UPDATE plans SET audit_log = false WHERE id IN ('free', 'solo', 'team');

-- NOTE: this gates *reading* the log, not writing it. audit_log rows keep being
-- recorded on every tier, deliberately:
--
--   - it is a security record before it is a feature. When something goes wrong
--     on a Team-plan account, we and they still need to know what happened;
--   - a customer who upgrades to Scale gets their actual history instead of an
--     empty page starting the day they paid;
--   - GDPR access requests are answered from it regardless of plan.
--
-- Stopping the writes would save a trivial amount of storage and destroy all
-- three.
