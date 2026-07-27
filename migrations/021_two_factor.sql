-- TOTP two-factor authentication.
--
-- totp_secret holds the base32 secret. It is only usable together with a code
-- from the user's device, and enabling it requires proving possession first
-- (see POST /auth/2fa/enable), so a secret that was generated but never
-- confirmed is inert — totp_enabled_at is what actually gates login.
--
-- totp_last_step records the 30-second step of the last accepted code so the
-- same code cannot be replayed inside its validity window.
ALTER TABLE users
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step bigint;

-- Single-use recovery codes for a lost authenticator device. Stored as SHA-256
-- hashes, never plaintext — they are shown to the user exactly once, at
-- enrolment, the same way API tokens are.
CREATE TABLE two_factor_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX two_factor_recovery_codes_user_idx ON two_factor_recovery_codes (user_id) WHERE used_at IS NULL;
