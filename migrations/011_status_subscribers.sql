-- Email subscribers for status-page updates. Double opt-in: a subscribe
-- request creates an unconfirmed row and sends a confirmation link; only
-- confirmed rows receive incident/maintenance/announcement notifications. This
-- stops the endpoint from being used to mail-bomb arbitrary addresses.
CREATE TABLE status_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  -- One-time confirmation token (hashed like other one-time tokens); NULL once
  -- confirmed.
  confirm_token_hash text,
  -- Capability token embedded in every notification's unsubscribe link. Stored
  -- in plaintext by design (like agent tokens): it must be reproducible to put
  -- in outgoing mail, and the worst it can do is unsubscribe one address.
  unsubscribe_token text NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_subscribers_confirmed_idx ON status_subscribers(email) WHERE confirmed_at IS NOT NULL;
