-- Last CLI version seen using this token, reported via the X-Devplat-CLI-Version
-- header on authenticated calls. Lets the dashboard tell a team when their CLI
-- is behind the latest release. NULL until a versioned CLI (not a `dev` build)
-- has authenticated with the token at least once.
ALTER TABLE api_tokens ADD COLUMN last_cli_version text;
