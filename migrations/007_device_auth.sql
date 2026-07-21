-- Device-authorization flow for `devplat login`: the CLI (which can't hold a
-- browser session) starts a request, the user approves it in the dashboard by
-- typing a short code, and the CLI polls until a real API token is minted for
-- it. Modeled on the OAuth 2.0 device grant.
--
-- Both codes are secrets, so — like api_tokens and verification_tokens — only
-- their SHA-256 hashes are stored, never the plaintext. device_code is the
-- long secret the CLI polls with; user_code is the short human-typed one.
CREATE TABLE device_auth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'completed', 'denied')),
  -- Bound at approval time to the approving user's team; the minted token
  -- belongs to this team.
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_polled_at timestamptz
);

-- Approval looks a pending request up by the user-entered code.
CREATE INDEX device_auth_user_code_idx ON device_auth_requests(user_code_hash)
  WHERE status = 'pending';
