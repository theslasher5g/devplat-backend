-- API token expiry.
--
-- Tokens were valid forever: a CI token minted by someone who left the company
-- two years ago still works today, and there was no rotation story at all.
-- NULL keeps the old behaviour (no expiry) so existing tokens keep working;
-- new ones can opt into a lifetime.
ALTER TABLE api_tokens ADD COLUMN expires_at timestamptz;

-- Session inventory.
--
-- Sessions were stateless JWTs, so we could revoke *all* of them (see
-- 022_session_revocation) but nobody could see which existed or sign out one
-- specific device. Each session now gets a row; the JWT carries its id in a
-- `sid` claim.
--
-- Device/IP are recorded so a user can recognise their own sessions — and spot
-- one they don't.
CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip text,
  revoked_at timestamptz
);

CREATE INDEX user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- Known devices, for "new sign-in from a device we haven't seen" alerts. The
-- fingerprint is a hash of user agent + IP prefix, never the raw values.
CREATE TABLE known_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);
