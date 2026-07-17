import type { FastifyInstance } from 'fastify';
import { config, type PlanTier } from '../config.js';
import { getPlan } from '../plans.js';
import { query, withTransaction } from '../db.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

/**
 * Platform-admin endpoints for the /admin dashboard. hosts/usage_events data
 * stays sparse (seed data only) until the Firecracker scheduler exists — the
 * queries already run against the real schema so nothing changes when it does.
 */
export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/hosts', { preHandler: requirePlatformAdmin }, async () => {
    const res = await query<{
      id: string; name: string; location: string; cpu_total: number; ram_total_mb: number;
      cpu_used: number; ram_used_mb: number; status: string; last_heartbeat: string | null;
    }>('SELECT * FROM hosts ORDER BY name');
    return {
      hosts: res.rows.map((h) => ({
        id: h.id,
        name: h.name,
        location: h.location,
        status: h.status,
        lastHeartbeat: h.last_heartbeat,
        cpu: { total: h.cpu_total, used: h.cpu_used },
        ramMb: { total: h.ram_total_mb, used: h.ram_used_mb },
      })),
    };
  });

  app.get('/admin/subscribers', { preHandler: requirePlatformAdmin }, async () => {
    const res = await query<{
      id: string; name: string; plan_tier: PlanTier; created_at: string;
      status: string | null; current_period_end: string | null;
      member_count: string; vm_starts_30d: string; owner_verified: boolean | null;
    }>(
      `SELECT t.id, t.name, t.plan_tier, t.created_at, s.status, s.current_period_end,
              (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
              (SELECT count(*) FROM usage_events ue
                WHERE ue.team_id = t.id AND ue.event_type = 'start'
                  AND ue.occurred_at > now() - interval '30 days') AS vm_starts_30d,
              -- The owner's verification status: registration creates the
              -- team immediately and emails a verification link async, so an
              -- owner who never clicks it (e.g. Resend not configured, email
              -- lost) leaves a team here that looks identical to a real one
              -- unless this is surfaced.
              (SELECT u.email_verified_at IS NOT NULL FROM team_members tm
                 JOIN users u ON u.id = tm.user_id
                 WHERE tm.team_id = t.id AND tm.role = 'owner' LIMIT 1) AS owner_verified
       FROM teams t LEFT JOIN subscriptions s ON s.team_id = t.id
       ORDER BY t.created_at DESC`,
    );
    return {
      teams: res.rows.map((t) => ({
        id: t.id,
        name: t.name,
        planTier: t.plan_tier,
        planLabel: getPlan(t.plan_tier).label,
        mrrChf: getPlan(t.plan_tier).chfMonthly,
        subscriptionStatus: t.status,
        currentPeriodEnd: t.current_period_end,
        members: Number(t.member_count),
        vmStarts30d: Number(t.vm_starts_30d),
        createdAt: t.created_at,
        ownerVerified: t.owner_verified ?? false,
      })),
    };
  });

  // Cleanup for signups that never verified (e.g. Resend wasn't configured, or
  // the owner just abandoned the flow) — refuses to touch a team whose owner
  // has verified, so this can't be used to delete a live customer by mistake.
  app.delete('/admin/teams/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = await query<{ email_verified_at: string | null }>(
      `SELECT u.email_verified_at FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 AND tm.role = 'owner' LIMIT 1`,
      [id],
    );
    if (owner.rows.length === 0) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (owner.rows[0].email_verified_at) {
      return reply.code(400).send({ error: 'owner_verified', detail: 'Refusing to delete a team whose owner has verified their email.' });
    }
    await withTransaction(async (tx) => {
      const members = await tx.query<{ user_id: string }>('SELECT user_id FROM team_members WHERE team_id = $1', [id]);
      await tx.query('DELETE FROM teams WHERE id = $1', [id]);
      // Also purge any member this team leaves as an orphaned, unverified
      // user — otherwise their email stays "taken" forever with no way to
      // sign up again, even though the team that email was tied to is gone.
      // Never touches a verified user, even if this was their only team.
      const memberIds = members.rows.map((m) => m.user_id);
      if (memberIds.length > 0) {
        await tx.query(
          `DELETE FROM users
             WHERE id = ANY($1) AND email_verified_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = users.id)`,
          [memberIds],
        );
      }
    });
    return reply.code(204).send();
  });

  app.get('/admin/overview', { preHandler: requirePlatformAdmin }, async () => {
    const [teams, activeSubs, starts, failures] = await Promise.all([
      query<{ count: string }>('SELECT count(*) FROM teams'),
      query<{ count: string }>("SELECT count(*) FROM subscriptions WHERE status IN ('active', 'trialing')"),
      query<{ count: string }>(
        "SELECT count(*) FROM usage_events WHERE event_type = 'start' AND occurred_at > now() - interval '7 days'",
      ),
      query<{ count: string }>(
        "SELECT count(*) FROM usage_events WHERE event_type = 'start_failed' AND occurred_at > now() - interval '7 days'",
      ),
    ]);
    const mrr = await query<{ plan_tier: PlanTier; count: string }>(
      "SELECT plan_tier, count(*) FROM teams WHERE plan_tier != 'free' GROUP BY plan_tier",
    );
    // A host counts as "connected" the same way the scheduler would treat it
    // as usable: a heartbeat within the configured timeout. Previously this
    // was hardcoded false, so the dashboard kept showing a "placeholder"
    // badge even once real agents were heartbeating in.
    const connected = await query<{ count: string }>(
      `SELECT count(*) FROM hosts WHERE last_heartbeat > now() - ($1 || ' seconds')::interval`,
      [String(config.agentHeartbeatTimeoutSeconds)],
    );
    const startCount = Number(starts.rows[0].count);
    const failCount = Number(failures.rows[0].count);
    return {
      totalTeams: Number(teams.rows[0].count),
      activeSubscriptions: Number(activeSubs.rows[0].count),
      mrrChf: mrr.rows.reduce((sum, r) => sum + getPlan(r.plan_tier).chfMonthly * Number(r.count), 0),
      vmStarts7d: startCount,
      vmStartFailures7d: failCount,
      vmStartErrorRate7d: startCount + failCount > 0 ? failCount / (startCount + failCount) : null,
      // Requires the data plane's registry proxy — no source for this yet.
      cacheHitRate: null,
      dataPlaneConnected: Number(connected.rows[0].count) > 0,
    };
  });
}
