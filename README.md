# devplat-backend

Control-plane API for [devplat](https://devplat.ch) — the remote backend for
Testcontainers. Node.js + TypeScript + Fastify + Postgres.

Covers: auth (JWT session cookie), email verification & password reset via
Resend (React Email templates), teams/roles/invites, API tokens, Stripe
subscriptions (Checkout + Customer Portal + webhook), plan limits for the
future scheduler, and platform-admin endpoints for `/admin`.

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
| Auth | `POST /auth/register` `POST /auth/login` `POST /auth/logout` `GET /auth/me` `POST /auth/verify-email` `POST /auth/resend-verification` `POST /auth/forgot-password` `POST /auth/reset-password` |
| Teams | `GET /teams/me` `PATCH /teams/me` `POST /teams/me/invites` `GET /invites/:token` `POST /invites/:token/accept` `PATCH/DELETE /teams/me/members/:userId` |
| Scheduler | `GET /teams/:id/limits` (session **or** `Authorization: Bearer dvp_…` API token) |
| API tokens | `GET/POST /tokens` `DELETE /tokens/:id` (plaintext returned exactly once on create) |
| Billing | `GET /billing/subscription` `POST /billing/checkout` `POST /billing/portal` `GET /billing/invoices` |
| Webhooks | `POST /webhooks/stripe` (signature-verified, raw body) |
| Admin | `GET /admin/overview` `GET /admin/hosts` `GET /admin/subscribers` (requires `users.is_platform_admin`) |

Sessions are httpOnly cookies (`devplat_session`, SameSite=Lax, shared across
`.devplat.ch`); `Authorization: Bearer <jwt>` works too. Team roles:
`owner` / `admin` / `developer` — billing, invites and member management need
owner/admin. Platform admin is a separate per-user flag:

```sql
UPDATE users SET is_platform_admin = true WHERE email = 'you@devplat.dev';
```

## Deployment on the VPS

Add the service to the existing `/opt/devplat/docker-compose.yml` (same file,
same `devplat_edge` network, Traefik routing via labels only — see
`deploy/docker-compose.api.yml` for the exact block to copy). Then:

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
