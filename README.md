# devplat-backend

Control-plane API for [devplat](https://devplat.ch) — the remote backend for
Testcontainers. Node.js + TypeScript + Fastify + Postgres.

Covers: auth (JWT session cookie, TOTP two-factor, session inventory), email
verification & password reset via Resend (React Email templates),
teams/roles/invites/multi-team membership, API tokens (expiry + IP
allowlists), the environment scheduler, Stripe subscriptions (Checkout +
Customer Portal + webhook), audit logging with CSV/JSON export, and
platform-admin endpoints for `/admin`.

## Local development

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET at minimum
npm run migrate               # apply migrations (also runs on server start)
npm run seed                  # optional: placeholder hosts/usage rows
npm run dev                   # tsx watch on :3000
```

Without `RESEND_API_KEY` outgoing mails are logged to stdout instead of sent;
without `STRIPE_SECRET_KEY` billing endpoints return errors but everything
else works.

## Stripe setup (once per mode, test → live)

```bash
STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup
```

Creates the Solo/Team/Scale products with monthly + yearly (−17 %) CHF prices
and prints the six `STRIPE_PRICE_*` env lines. Then point a webhook at
`https://api.devplat.ch/webhooks/stripe` with events
`checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, and put its signing secret into
`STRIPE_WEBHOOK_SECRET`.

## API surface (summary)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register` `POST /auth/login` `POST /auth/logout` `GET /auth/me` `POST /auth/verify-email` `POST /auth/resend-verification` `POST /auth/forgot-password` `POST /auth/reset-password` `POST /auth/change-password` `POST /auth/change-email(/confirm)` `DELETE /auth/me` |
| Two-factor | `GET /auth/2fa` `POST /auth/2fa/setup` `POST /auth/2fa/enable` `POST /auth/2fa/disable` |
| Sessions | `GET /auth/sessions` `DELETE /auth/sessions/:id` `POST /auth/sessions/revoke-others` |
| Device login | `POST /auth/device/start` `POST /auth/device/token` (both unauthenticated) `POST /auth/device/approve` |
| Teams | `GET /teams` `POST /teams` `POST /teams/switch` `GET/PATCH/DELETE /teams/me` `POST /teams/me/invites` `DELETE /teams/me/invites/:id` `GET /invites/:token` `POST /invites/:token/accept` `PATCH/DELETE /teams/me/members/:userId` `POST /teams/me/leave` `POST /teams/me/transfer-ownership` |
| Team security | `GET/PATCH /teams/me/security` (team-wide 2FA requirement) |
| Audit | `GET /teams/me/audit` `GET /teams/me/audit/actions` `GET /teams/me/audit/export?format=csv\|json` |
| Environments | `POST /environments` `GET /environments(/:id)` `DELETE /environments/:id` `GET /environments/:id/tunnel(/:port)` `GET /environments/:id/containers` `GET /environments/history` `GET /environments/usage` `GET /environments/pressure` |
| Scheduler | `GET /teams/:id/limits` (session **or** `Authorization: Bearer dvp_…` API token) |
| API tokens | `GET/POST /tokens` `DELETE /tokens/:id` (plaintext returned exactly once on create; optional `expiresInDays` + `ipAllowlist`) |
| Billing | `GET /billing/subscription` `POST /billing/checkout` `POST /billing/portal` `GET /billing/invoices` |
| Account | `GET /account/export` (GDPR Art. 15/20) |
| Public | `GET /status` `POST /status/subscribe` `GET /cli/latest-version` `GET /promo` `POST /contact` |
| Webhooks (in) | `POST /webhooks/stripe` (signature-verified, raw body) |
| Webhooks (out) | `GET/POST /webhook-endpoints` `PATCH/DELETE /webhook-endpoints/:id` `POST /webhook-endpoints/:id/rotate-secret` `POST /webhook-endpoints/:id/test` `GET /webhook-deliveries` `POST /webhook-deliveries/:id/redeliver` |
| Admin | `GET /admin/overview` `GET /admin/hosts` `GET /admin/subscribers` `GET /admin/system` `GET /admin/audit` `GET /admin/timeseries` … (all require `users.is_platform_admin`) |

Sessions are httpOnly cookies (`devplat_session`, SameSite=Lax, shared across
`.devplat.ch`); `Authorization: Bearer <jwt>` works too. Team roles:
`owner` / `admin` / `developer` — billing, invites and member management need
owner/admin. Platform admin is a separate per-user flag:

```sql
UPDATE users SET is_platform_admin = true WHERE email = 'you@devplat.dev';
```

## Auth and account security

**Passwords** (`src/lib/passwordPolicy.ts`) must be 12–200 characters with an
upper- and lowercase letter, a digit, and a special character, and are checked
against Have I Been Pwned's breach corpus over the k-anonymity range API — only
the first five characters of the SHA-1 hash ever leave the process, and the
check fails open if HIBP is unreachable. Enforced server-side on registration,
reset and change; the frontend mirrors the rules for live feedback only.

**Two-factor** is TOTP (RFC 6238), implemented directly on `node:crypto` in
`src/lib/totp.ts` — no dependency, and covered by the published test vectors in
`test/totp.test.ts`. Enrolment returns an `otpauth://` URI (rendered as a QR
code in the dashboard) plus ten single-use recovery codes, stored hashed. Codes
are accepted within ±1 step of clock skew, and the matched step is recorded so
the same code can't be replayed.

A team owner can require 2FA for the whole team (`PATCH /teams/me/security`).
That check lives in `requireMember`, deliberately **not** in `requireUser`: a
member who hasn't enrolled yet must still be able to reach their own profile to
do so, they just can't touch team resources until they have.

**Sessions** carry a `sid` claim backed by a `user_sessions` row, so
`GET /auth/sessions` can list active devices and `DELETE /auth/sessions/:id`
can drop one. `users.sessions_valid_from` is a cut-off compared against each
token's `iat` — bumping it (password change, 2FA disable) invalidates every
token issued before that moment in one write.

**Security event emails** (`src/lib/securityEvents.ts`) notify on sign-in from
an unrecognised device (hashed user-agent + /24 prefix; the first device is
silent, since everyone has a first device), token creation, 2FA being disabled,
password change and ownership transfer.

**API tokens** may carry an expiry and an IP allowlist. Matching is done in
Postgres with native `inet`/`cidr` and the `<<=` containment operator, so
subnet arithmetic isn't reimplemented in JS; `src/lib/cidr.ts` only validates
input before it reaches the database. Rejections use distinct error codes
(`api_token_expired`, `ip_not_allowed`, `two_factor_required`,
`seat_limit_reached`, …) that the CLI turns into command-specific advice.

## Background jobs

The queue worker, health poller, maintenance sweep, capacity-notice sweep,
trial-notice sweep and webhook delivery worker each run under a Postgres
advisory lock (`src/lib/advisoryLock.ts`), so exactly one instance executes a
given tick even with multiple replicas or during a rolling deploy.
`pg_try_advisory_lock` is non-blocking — a losing instance skips that tick
rather than queueing a backlog — and the lock is released with the connection,
so a killed instance can't wedge the scheduler.

### Outgoing webhooks

Environment events (`environment.assigned` / `.released` / `.failed` /
`.queued_at_limit`) are queued into `webhook_deliveries` and sent by the
delivery worker: six attempts over ~9 hours, `2xx` to acknowledge, and an
endpoint is auto-disabled after ten consecutive undeliverable events.

Each request carries `devplat-signature: t=<unix>,v1=<hmac-sha256 of
"t.body">`. The timestamp is part of the signed material, which is what lets a
receiver reject a replayed delivery.

**SSRF is the real risk here**, and `src/lib/ssrfGuard.ts` is the control: this
process is on the WireGuard mesh and can reach every agent's unauthenticated
Docker API, so a webhook URL of `http://10.x.x.x:2375/…` would otherwise be a
host compromise. Non-public addresses are refused *inside the socket's DNS
lookup*, not in a check beforehand — a check-then-connect implementation is
defeated by DNS rebinding. Redirects are never followed, and `node:https` is
used precisely because it supports a custom `lookup` and doesn't follow them.

### Capacity pressure

`reserveSlot()` stamps `environment_requests.capacity_blocked_at` the first
time a run is turned away by the team's own parallelism cap (never on retries,
and never for a lapsed trial). That feeds `GET /environments/pressure`, the
dashboard notice, and a monthly owner email when five or more runs waited
inside a fortnight.

## Tests

```bash
npm test        # node:test, no database required
```

Covers the pure-logic pieces where a silent regression is expensive: TOTP
against the RFC 6238 vectors, the password policy and HIBP lookup (with `fetch`
stubbed), CIDR validation, audit-export filter parsing and CSV escaping,
webhook signing/replay rejection, and the SSRF address filter — including an
end-to-end case that stands up a real loopback HTTP server and asserts a
guarded request never reaches it.

## Deployment on the VPS

Add the service to the existing `/opt/devplat/docker-compose.yml` (same file,
same `edge` network key (external network `devplat_edge`), Traefik routing via
labels only — see `deploy/docker-compose.api.yml` for the exact block to
copy). Then:

```bash
cd /opt/devplat/backend && git pull && cd .. && docker compose up -d --build api
```

Postgres stays internal-only: the API reaches it as `postgres:5432` inside the
compose network. Migrations run automatically at container start.

## Notes / open infrastructure items

- **Email sender domain**: DNS/SPF/DKIM for `noreply@devplat.dev` is **not**
  set up yet — Resend will refuse to send from it until the domain is verified
  in the Resend dashboard. Infra task, not code.
- `hosts` / `usage_events` are part of the schema but only carry seed data
  until the Firecracker scheduler (separate project) reports real events. The
  admin endpoints already read from the real tables.
- The schema adds a few pragmatic columns beyond the original sketch:
  `api_tokens.label/token_prefix/scope/revoked_at`,
  `users.is_platform_admin`, `teams.trial_ends_at`, and a `team_invites`
  table (invitees may not have accounts yet, so `verification_tokens`
  can't hold invites).
