-- Seat caps per plan.
--
-- Scale was previously unlimited (NULL). "Unlimited seats" on a per-parallelism
-- product is a pricing hole rather than a generosity: one Scale subscription
-- could carry an entire company, all sharing 8 parallel environments, and the
-- next plan up doesn't exist. 30 is well above what a team that needs 8
-- parallel environments actually has, so it caps abuse without being felt by
-- real customers.
--
-- Solo stays at 1 — that is what makes it Solo. Free stays at 1 too: a trial is
-- for evaluating the product, not for running a team on.
UPDATE plans SET max_members = 30 WHERE id = 'scale';

-- Re-assert the others so this migration fully describes the intended state
-- rather than depending on what 023 happened to leave behind.
UPDATE plans SET max_members = 1  WHERE id = 'free';
UPDATE plans SET max_members = 1  WHERE id = 'solo';
UPDATE plans SET max_members = 10 WHERE id = 'team';
