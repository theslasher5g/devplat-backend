import type { FastifyInstance } from 'fastify';
import { one, query } from '../db.js';
import { auditFromReq } from '../lib/audit.js';
import { requireUser } from '../plugins/auth.js';

/**
 * Self-service data export, covering the GDPR/FADP right of access (Art. 15)
 * and portability (Art. 20). Marketing the product on Swiss and EU data
 * protection while making those rights a manual support request is a bad look
 * — and a slow one when a request has a statutory deadline attached.
 *
 * Scope is deliberately the requesting user: their account, their memberships,
 * and — only for teams they administer — that team's operational records. A
 * developer can't pull a whole company's audit log out through this.
 *
 * Secrets are never included: password hashes, TOTP secrets, recovery codes and
 * API token hashes are excluded by column, not by hoping nobody notices.
 */
export default async function dataExportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/account/export', {
    preHandler: requireUser,
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const userId = req.user.id;

    const user = await one<{
      id: string; email: string; created_at: string; email_verified_at: string | null;
      totp_enabled_at: string | null;
    }>(
      'SELECT id, email, created_at, email_verified_at, totp_enabled_at FROM users WHERE id = $1',
      [userId],
    );

    const memberships = await query<{
      team_id: string; team_name: string; role: string; joined_at: string; plan_tier: string;
    }>(
      `SELECT t.id AS team_id, t.name AS team_name, tm.role, tm.created_at AS joined_at,
              COALESCE(t.plan_override, t.plan_tier) AS plan_tier
       FROM team_members tm JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = $1 ORDER BY tm.created_at`,
      [userId],
    );

    // Team-level records only for teams where this user is owner/admin.
    const adminTeamIds = memberships.rows.filter((m) => m.role !== 'developer').map((m) => m.team_id);

    const teams = [];
    for (const teamId of adminTeamIds) {
      const [tokens, runs, auditRows, invites] = await Promise.all([
        query<{ label: string; prefix: string; scope: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
          `SELECT label, token_prefix AS prefix, scope, created_at, last_used_at, revoked_at
           FROM api_tokens WHERE team_id = $1 ORDER BY created_at`, [teamId],
        ),
        query<{ id: string; status: string; vm_id: string | null; requested_at: string; released_at: string | null; error: string | null }>(
          `SELECT id, status, vm_id, requested_at, released_at, error
           FROM environment_requests WHERE team_id = $1 ORDER BY requested_at DESC LIMIT 1000`, [teamId],
        ),
        query<{ action: string; target: string | null; actor_email: string | null; created_at: string }>(
          `SELECT action, target, actor_email, created_at
           FROM audit_log WHERE team_id = $1 ORDER BY created_at DESC LIMIT 1000`, [teamId],
        ),
        query<{ email: string; role: string; created_at: string; accepted_at: string | null }>(
          'SELECT email, role, created_at, accepted_at FROM team_invites WHERE team_id = $1 ORDER BY created_at', [teamId],
        ),
      ]);
      const meta = memberships.rows.find((m) => m.team_id === teamId)!;
      teams.push({
        id: teamId,
        name: meta.team_name,
        planTier: meta.plan_tier,
        yourRole: meta.role,
        apiTokens: tokens.rows.map((t) => ({
          label: t.label, prefix: t.prefix, scope: t.scope,
          createdAt: t.created_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at,
        })),
        environmentRuns: runs.rows.map((r) => ({
          id: r.id, status: r.status, vmId: r.vm_id,
          requestedAt: r.requested_at, releasedAt: r.released_at, error: r.error,
        })),
        auditLog: auditRows.rows.map((a) => ({
          action: a.action, target: a.target, actor: a.actor_email, at: a.created_at,
        })),
        invitations: invites.rows.map((i) => ({
          email: i.email, role: i.role, sentAt: i.created_at, acceptedAt: i.accepted_at,
        })),
      });
    }

    await auditFromReq(req, 'account.export', { teamId: null, target: user.email });

    const payload = {
      exportedAt: new Date().toISOString(),
      notice: 'Personal data held by devplat for this account. Secrets (password hash, '
        + 'two-factor secret, recovery codes, API token values) are deliberately excluded — '
        + 'they are stored only as irreversible hashes and cannot be exported.',
      account: {
        id: user.id,
        email: user.email,
        createdAt: user.created_at,
        emailVerifiedAt: user.email_verified_at,
        twoFactorEnabledAt: user.totp_enabled_at,
      },
      teamMemberships: memberships.rows.map((m) => ({
        teamId: m.team_id, teamName: m.team_name, role: m.role, joinedAt: m.joined_at,
      })),
      // Present only for teams the user administers.
      teams,
    };

    const filename = `devplat-export-${new Date().toISOString().slice(0, 10)}.json`;
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(JSON.stringify(payload, null, 2));
  });
}
