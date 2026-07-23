-- Attribute each environment request to the API token that started it (when
-- one did — dashboard/session runs have no token and stay NULL), so the
-- dashboard can show per-token usage. ON DELETE SET NULL keeps historical
-- requests after a token is revoked/deleted; the run just loses its
-- attribution rather than vanishing.
ALTER TABLE environment_requests
  ADD COLUMN token_id uuid REFERENCES api_tokens(id) ON DELETE SET NULL;

CREATE INDEX environment_requests_token_idx ON environment_requests (token_id, requested_at DESC);
