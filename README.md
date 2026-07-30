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
| Admin | `GET /admin/hosts` and `GET /admin/hosts/:id/detail` carry measured usage beside the committed figures; the detail view also fetches live per-VM usage from the agent. `GET /admin/overview` `GET /admin/hosts` `GET /admin/subscribers` `GET /admin/system` `GET /admin/audit` `GET /admin/timeseries` … (all require `users.is_platform_admin`) |

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

### Host usage telemetry

`hosts.cpu_used` / `ram_used_mb` are the sum of what running VMs' plans
*promised*. That is the right thing to admit against — it is what must be
honourable if every guest peaks at once — but it cannot move when load does, so
it says nothing about whether the hardware is busy.

Migration 035 adds a second, measured set of columns beside them: what guests
report using, what the balloons hold back, the host's own `MemAvailable`, CPU
busy share, actual vCPU consumption, and how many guests hit their `cpu.max`
quota. Both the agent heartbeat and the scheduler's health poll write them.

**Every one of those columns is nullable, and that is load-bearing.** `NULL`
means the host's agent does not report it. A reader treating `NULL` as `0` would
see an unmeasured host as completely idle — the most attractive possible target
for the next placement, and the least true. `usage_reported_at` carries the same
weight for staleness: an agent that dies leaves its last values sitting in the
row looking current forever, so `lib/hostUsage.ts` treats anything older than
two minutes as unmeasured. Absent and stale are kept distinguishable because the
dashboard says different things about a host running an old agent and one whose
agent just died.

Nothing acts on any of this yet. It exists so an overcommit factor can be sized
from evidence rather than estimated, and so placement can later be ordered by
real load.

### The free trial is per user, not per team

`POST /teams` used to give every new team a fresh 14-day trial with no cap on
how many a person could create. That is not merely "a trial can be extended":
the free tier grants one parallel environment per team, so ten teams is ten
concurrent environments — more parallelism than the Solo plan costs CHF 19 a
month to get. The 10/hour rate limit bounded the speed of the abuse, not the
abuse.

`users.trial_started_at` (migration 036) makes the trial a property of the
person. Registration claims it; a later `POST /teams` grants a trial only if it
is still unclaimed, and otherwise creates the team with `trial_ends_at = now()`
— already expired, which `effectivePlan()` already treats as zero parallel
environments. Reusing the expiry path avoids a second notion of "not entitled"
to keep in sync.

The claim and the row lock are one statement:
`UPDATE users SET trial_started_at = COALESCE(trial_started_at, now()) …
RETURNING (trial_started_at = now())`. `now()` is the transaction timestamp, so
equality is true exactly when *this* call consumed it, and the lock serialises
concurrent creates from the same account.

Capping team count alone would only have raised the price of the trick; binding
the trial removes the reason to try. The cap (5 owned teams) stays as hygiene
against audit noise and invite spam from a compromised account.

Being invited into someone else's team consumes nothing — that person still has
their own trial if they later start a team themselves.

Note the honest limit: this stops one account minting trials. It does not stop
someone registering several accounts with different addresses. Email
verification raises the cost; properly closing it would need payment-method or
device signals, which we do not collect today.

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
