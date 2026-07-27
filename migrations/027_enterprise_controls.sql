-- Team-wide two-factor enforcement.
--
-- 2FA was per-user and optional, so a company had no way to hold its own
-- members to its security policy. When this is on, members without TOTP are
-- blocked from the team's resources — but NOT from the endpoints they need to
-- enrol (see requireMember vs requireUser), so switching it on is a prompt to
-- comply rather than a lockout.
ALTER TABLE teams ADD COLUMN require_two_factor boolean NOT NULL DEFAULT false;

-- Per-token IP allowlist.
--
-- A leaked CI token is only useful from the network it's allowed on. Stored as
-- native inet CIDRs so matching uses Postgres's own `<<=` containment operator
-- rather than hand-rolled subnet arithmetic — correct for IPv4 and IPv6 alike.
-- NULL/empty means "any address", which stays the default.
ALTER TABLE api_tokens ADD COLUMN ip_allowlist cidr[];
