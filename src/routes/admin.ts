import type { FastifyInstance } from 'fastify';
import { PLAN_LIMITS, type PlanTier } from '../config.js';
import { query } from '../db.js';
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
      member_count: string; vm_starts_30d: string;
    }>(
      `SELECT t.id, t.name, t.plan_tier, t.created_at, s.status, s.current_period_end,
              (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
              (SELECT count(*) FROM usage_events ue
                WHERE ue.team_id = t.id AND ue.event_type = 'start'
                  AND ue.occurred_at > now() - interval '30 days') AS vm_starts_30d
       FROM teams t LEFT JOIN subscriptions s ON s.team_id = t.id
       ORDER BY t.created_at DESC`,
    );
    return {
      teams: res.rows.map((t) => ({
        id: t.id,
        name: t.name,
        planTier: t.plan_tier,
        planLabel: PLAN_LIMITS[t.plan_tier].label,
        mrrChf: PLAN_LIMITS[t.plan_tier].chfMonthly,
        subscriptionStatus: t.status,
        currentPeriodEnd: t.current_period_end,
        members: Number(t.member_count),
        vmStarts30d: Number(t.vm_starts_30d),
        createdAt: t.created_at,
      })),
    };
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
    const startCount = Number(starts.rows[0].count);
    const failCount = Number(failures.rows[0].count);
    return {
      totalTeams: Number(teams.rows[0].count),
      activeSubscriptions: Number(activeSubs.rows[0].count),
      mrrChf: mrr.rows.reduce((sum, r) => sum + PLAN_LIMITS[r.plan_tier].chfMonthly * Number(r.count), 0),
      vmStarts7d: startCount,
      vmStartFailures7d: failCount,
      vmStartErrorRate7d: startCount + failCount > 0 ? failCount / (startCount + failCount) : null,
      // Requires the data plane's registry proxy — no source for this yet.
      cacheHitRate: null,
      dataPlaneConnected: false,
    };
  });
}
