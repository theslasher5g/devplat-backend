-- Manual plan override ("comp"/grant), decoupled from billing.
--
-- plan_tier stays the billing truth: it's what Stripe writes on
-- checkout/renewal/cancel and what invoices + MRR are computed from. Letting
-- an admin edit plan_tier directly would be fought by the next Stripe webhook
-- (webhooks.ts writes plan_tier), and would also distort MRR.
--
-- plan_override is the ENTITLEMENT the team actually gets to use — set by an
-- admin to grant a paid tier's capacity for free (beta users, support cases,
-- internal teams) without creating a Stripe subscription or any charge. When
-- non-NULL it takes precedence for entitlements only (parallelism + per-env
-- resource caps + trial gating); billing/subscription state is untouched.
--
-- NULL means "no override — use the billing plan_tier", the normal case.
ALTER TABLE teams
  ADD COLUMN plan_override text
    CHECK (plan_override IN ('free', 'solo', 'team', 'scale'));
