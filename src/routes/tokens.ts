import type { FastifyInstance } from 'fastify';
import { maybeOne, query } from '../db.js';
import { auditFromReq } from '../lib/audit.js';
import { generateApiToken } from '../lib/tokens.js';
import { isValidCidr, normalizeCidr } from '../lib/cidr.js';
import { notifyTokenCreated } from '../lib/securityEvents.js';
import { requireMember } from '../plugins/auth.js';

export default async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tokens', { preHandler: requireMember }, async (req) => {
    const teamId = req.membership.teamId;
    const SPARK_DAYS = 14;
    const [res, runs] = await Promise.all([
      query<{
        id: string; label: string; token_prefix: string; scope: string;
        created_at: string; last_used_at: string | null; last_cli_version: string | null;
        expires_at: string | null; ip_allowlist: string[] | null;
        created_by: string | null; created_by_email: string | null;
      }>(
        `SELECT t.id, t.label, t.token_prefix, t.scope, t.created_at, t.last_used_at, t.last_cli_version,
                t.expires_at, t.ip_allowlist::text[] AS ip_allowlist,
                t.created_by, u.email AS created_by_email
         FROM api_tokens t
         LEFT JOIN users u ON u.id = t.created_by
         WHERE t.team_id = $1 AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
        [teamId],
      ),
      // Per-token run counts per day over the window, for the usage sparkline.
      query<{ token_id: string; day: string; count: string }>(
        `SELECT token_id, to_char(date_trunc('day', requested_at), 'YYYY-MM-DD') AS day, count(*) AS count
         FROM environment_requests
         WHERE team_id = $1 AND token_id IS NOT NULL
           AND requested_at >= date_trunc('day', now()) - ($2::int - 1) * interval '1 day'
         GROUP BY token_id, day`,
        [teamId, SPARK_DAYS],
      ),
    ]);

    // Build a gap-free day axis, then bucket each token's counts onto it.
    const axis: string[] = [];
    for (let i = SPARK_DAYS - 1; i >= 0; i--) {
      axis.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
    }
    const byToken = new Map<string, Map<string, number>>();
    for (const r of runs.rows) {
      const m = byToken.get(r.token_id) ?? new Map<string, number>();
      m.set(r.day, Number(r.count));
      byToken.set(r.token_id, m);
    }

    // The revoke rule is decided here and shipped with each row rather than
    // re-derived in the UI: the button and the endpoint then cannot disagree,
    // and a future change to the rule can't leave a live button that 403s.
    const isTeamAdmin = req.membership.role !== 'developer';
    return {
      tokens: res.rows.map((t) => {
        const m = byToken.get(t.id);
        const usage = axis.map((d) => m?.get(d) ?? 0);
        return {
          id: t.id,
          label: t.label,
          prefix: t.token_prefix,
          scope: t.scope,
          createdBy: t.created_by_email,
          createdByMe: t.created_by === req.user.id,
          canRevoke: isTeamAdmin || t.created_by === req.user.id,
          createdAt: t.created_at,
          lastUsedAt: t.last_used_at,
          lastCliVersion: t.last_cli_version,
          expiresAt: t.expires_at,
          ipAllowlist: t.ip_allowlist ?? [],
          usage, // 14 daily run counts, oldest→newest
          runsTotal: usage.reduce((a, b) => a + b, 0),
        };
      }),
    };
  });

  app.post('/tokens', {
    preHandler: requireMember,
    schema: {
      body: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 120 },
          scope: { type: 'string', enum: ['ci:run', 'dev:run'] },
          // Optional lifetime. Omitted means "never expires", which stays the
          // default so existing automation isn't broken by this being added.
          expiresInDays: { type: 'integer', minimum: 1, maximum: 730 },
          // Optional CIDR allowlist, e.g. ["203.0.113.0/24"]. Empty/omitted
          // means the token works from anywhere, which stays the default.
          ipAllowlist: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
        },
      },
    },
    // Minting credentials is a privileged action; a hijacked session shouldn't
    // be able to spray out hundreds of long-lived tokens before anyone notices.
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { label, scope = 'ci:run', expiresInDays, ipAllowlist } = req.body as {
      label: string; scope?: 'ci:run' | 'dev:run'; expiresInDays?: number; ipAllowlist?: string[];
    };
    // Validate CIDRs before storing: a typo here would silently lock a CI
    // pipeline out, and the failure would surface far from its cause.
    const rawCidrs = (ipAllowlist ?? []).map((c) => c.trim()).filter(Boolean);
    for (const c of rawCidrs) {
      if (!isValidCidr(c)) {
        return reply.code(400).send({
          error: 'invalid_cidr',
          detail: `"${c}" is not a valid IP address or CIDR range (e.g. 203.0.113.4 or 203.0.113.0/24).`,
        });
      }
    }
    const { token, hash, prefix } = generateApiToken(scope);
    const row = await query<{ id: string; created_at: string; expires_at: string | null }>(
      `INSERT INTO api_tokens (team_id, label, token_prefix, scope, token_hash, expires_at, ip_allowlist, created_by)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() + ($6 || ' days')::interval END,
               CASE WHEN cardinality($7::text[]) = 0 THEN NULL ELSE $7::cidr[] END,
               $8)
       RETURNING id, created_at, expires_at`,
      [req.membership.teamId, label.trim(), prefix, scope, hash, expiresInDays ?? null, rawCidrs.map(normalizeCidr), req.user.id],
    );
    await auditFromReq(req, 'token.create', { target: label.trim(), detail: { scope, prefix, expiresInDays: expiresInDays ?? null } });
    // Minting a credential is exactly the action an account-takeover would
    // perform first; tell the user out-of-band.
    notifyTokenCreated(req, req.user.email, label.trim());
    // The plaintext token is returned exactly once and never stored.
    return reply.code(201).send({
      token,
      id: row.rows[0].id,
      label: label.trim(),
      prefix,
      scope,
      createdAt: row.rows[0].created_at,
      expiresAt: row.rows[0].expires_at,
    });
  });

  // Revoking is irreversible — the plaintext was never stored, so a token taken
  // out cannot be put back, only replaced, and anything running on it breaks at
  // once. A developer may therefore only revoke tokens they minted themselves;
  // owners and admins may revoke any of the team's, including the inherited ones
  // with no recorded creator.
  app.delete('/tokens/:id', { preHandler: requireMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await maybeOne<{ created_by: string | null }>(
      'SELECT created_by FROM api_tokens WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL',
      [id, req.membership.teamId],
    );
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (req.membership.role === 'developer' && target.created_by !== req.user.id) {
      return reply.code(403).send({
        error: 'token_not_yours',
        detail: 'You can only revoke tokens you created yourself. Ask a team owner or admin to revoke this one.',
      });
    }
    const found = await maybeOne<{ id: string; label: string }>(
      'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL RETURNING id, label',
      [id, req.membership.teamId],
    );
    // Lost a race with a concurrent revoke — the token is gone either way.
    if (!found) return reply.code(404).send({ error: 'not_found' });
    await auditFromReq(req, 'token.revoke', { target: found.label });
    return { ok: true };
  });
}
