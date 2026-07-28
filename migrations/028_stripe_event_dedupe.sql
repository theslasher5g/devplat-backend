-- Records every Stripe webhook event we have already handled.
--
-- Stripe retries a delivery until it gets a 2xx — on a timeout, a deploy
-- restart, or a 500 — and it makes no ordering guarantees. Most handlers are
-- upserts and survive a replay, but invoice.payment_failed sends the customer
-- a dunning email, so a retry meant a second "your payment failed" mail for a
-- single failed charge.
--
-- The event id is the natural key: Stripe guarantees it is stable across
-- retries of the same event.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- The table only exists to answer "have I seen this id", so old rows are
-- worthless after Stripe stops retrying (it gives up well inside 3 days).
-- Indexed so the periodic prune doesn't scan the whole table.
CREATE INDEX IF NOT EXISTS stripe_events_processed_at_idx ON stripe_events (processed_at);
