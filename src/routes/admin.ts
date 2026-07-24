import type { FastifyInstance } from 'fastify';
import { config, type PlanTier } from '../config.js';
import { getPlan } from '../plans.js';
import { query, withTransaction } from '../db.js';
import { type AuditRow, auditFromReq, serializeAudit } from '../lib/audit.js';
import { stripe } from '../lib/stripe.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

/** Best-effort cancel of a team's Stripe subscription before the team row is
 *  deleted, so removing a paying team doesn't leave it billing in Stripe.
 *  Silent no-op when Stripe isn't configured or the team has no subscription;
 *  a Stripe error is swallowed (logged) rather than blocking the delete — the
 *  local record is the thing the admin asked to remove. */
async function cancelTeamStripeSubscription(teamId: string): Promise<void> {
  if (!stripe) return;
  const sub = await query<{ stripe_subscription_id: string }>(
    'SELECT stripe_subscription_id FROM subscriptions WHERE team_id = $1', [teamId],
  );
  const subId = sub.rows[0]?.stripe_subscription_id;
  if (!subId) return;
  try {
    await stripe.subscriptions.cancel(subId);
  } catch (err) {
    console.error(`[admin] failed to cancel Stripe subscription ${subId} for team ${teamId}`, err);
  }
}

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

  app.get('/admin/subscribers', { preHandler: requirePlatformAdmin }, async (req) => {
    // Optional case-insensitive search over team name OR any member's email.
    const q = ((req.query as { q?: string }).q ?? '').trim();
    const like = `%${q}%`;
    const res = await query<{
      id: string; name: string; plan_tier: PlanTier; plan_override: PlanTier | null; created_at: string;
      status: string | null; current_period_end: string | null; owner_email: string | null;
      member_count: string; vm_starts_30d: string; owner_verified: boolean | null;
    }>(
      `SELECT t.id, t.name, t.plan_tier, t.plan_override, t.created_at, s.status, s.current_period_end,
              (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
              (SELECT count(*) FROM usage_events ue
                WHERE ue.team_id = t.id AND ue.event_type = 'start'
                  AND ue.occurred_at > now() - interval '30 days') AS vm_starts_30d,
              -- The owner's email + verification status: registration creates the
              -- team immediately and emails a verification link async, so an
              -- owner who never clicks it (e.g. Resend not configured, email
              -- lost) leaves a team here that looks identical to a real one
              -- unless this is surfaced.
              (SELECT u.email FROM team_members tm JOIN users u ON u.id = tm.user_id
                 WHERE tm.team_id = t.id AND tm.role = 'owner' LIMIT 1) AS owner_email,
              (SELECT u.email_verified_at IS NOT NULL FROM team_members tm
                 JOIN users u ON u.id = tm.user_id
                 WHERE tm.team_id = t.id AND tm.role = 'owner' LIMIT 1) AS owner_verified
       FROM teams t LEFT JOIN subscriptions s ON s.team_id = t.id
       WHERE $1 = ''
          OR t.name ILIKE $2
          OR EXISTS (SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id
                       WHERE tm.team_id = t.id AND u.email ILIKE $2)
       ORDER BY t.created_at DESC`,
      [q, like],
    );
    return {
      teams: res.rows.map((t) => ({
        id: t.id,
        name: t.name,
        // Billing plan (Stripe truth) drives MRR; plan_override is the manual
        // entitlement grant, surfaced separately so the two aren't conflated.
        planTier: t.plan_tier,
        planLabel: getPlan(t.plan_tier).label,
        planOverride: t.plan_override,
        planOverrideLabel: t.plan_override ? getPlan(t.plan_override).label : null,
        mrrChf: getPlan(t.plan_tier).chfMonthly,
        subscriptionStatus: t.status,
        currentPeriodEnd: t.current_period_end,
        ownerEmail: t.owner_email,
        members: Number(t.member_count),
        vmStarts30d: Number(t.vm_starts_30d),
        createdAt: t.created_at,
        ownerVerified: t.owner_verified ?? false,
      })),
    };
  });

  // Set or clear a team's manual plan override. This grants (or revokes) the
  // entitlements of a tier WITHOUT touching Stripe, the subscription, or MRR —
  // planTier stays whatever billing says. `planOverride: null` clears it.
  app.patch('/admin/teams/:id', {
    preHandler: requirePlatformAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['planOverride'],
        properties: { planOverride: { type: ['string', 'null'], enum: ['free', 'solo', 'team', 'scale', null] } },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { planOverride } = req.body as { planOverride: PlanTier | null };
    const found = await query<{ name: string }>('UPDATE teams SET plan_override = $1 WHERE id = $2 RETURNING name', [planOverride, id]);
    if (found.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    // Audit against the team so it shows in that team's log too.
    void auditFromReq(req, planOverride ? 'plan.override.set' : 'plan.override.clear',
      { teamId: id, target: found.rows[0].name, detail: { planOverride } });
    return { ok: true, planOverride, planOverrideLabel: planOverride ? getPlan(planOverride).label : null };
  });

  // All users, newest first, with their team memberships — optional ?q= search
  // over email. Powers the admin's user list / search / delete.
  app.get('/admin/users', { preHandler: requirePlatformAdmin }, async (req) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    const like = `%${q}%`;
    const res = await query<{
      id: string; email: string; email_verified_at: string | null; is_platform_admin: boolean;
      created_at: string; teams: { teamId: string; teamName: string; role: string }[] | null;
    }>(
      `SELECT u.id, u.email, u.email_verified_at, u.is_platform_admin, u.created_at,
              COALESCE(
                (SELECT json_agg(json_build_object('teamId', t.id, 'teamName', t.name, 'role', tm.role)
                                 ORDER BY tm.created_at)
                   FROM team_members tm JOIN teams t ON t.id = tm.team_id
                   WHERE tm.user_id = u.id),
                '[]'::json) AS teams
       FROM users u
       WHERE $1 = '' OR u.email ILIKE $2
       ORDER BY u.created_at DESC`,
      [q, like],
    );
    return {
      users: res.rows.map((u) => ({
        id: u.id,
        email: u.email,
        verified: u.email_verified_at !== null,
        isPlatformAdmin: u.is_platform_admin,
        createdAt: u.created_at,
        teams: u.teams ?? [],
      })),
    };
  });

  // Delete a user. Deleting a platform admin (including yourself) is refused so
  // the admin can't be locked out. Team memberships cascade; any team the user
  // was the SOLE member of is removed too (best-effort Stripe cancel first),
  // rather than leaving an orphaned, memberless team behind.
  app.delete('/admin/users/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user.id) return reply.code(400).send({ error: 'self', detail: 'You cannot delete your own account here.' });
    const target = await query<{ is_platform_admin: boolean; email: string }>('SELECT is_platform_admin, email FROM users WHERE id = $1', [id]);
    if (target.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    if (target.rows[0].is_platform_admin) {
      return reply.code(400).send({ error: 'is_admin', detail: 'Refusing to delete a platform admin.' });
    }
    // Teams this user solely owns/occupies — they'll be memberless after the
    // user goes, so tear them down (and cancel their Stripe sub) too.
    const soleTeams = await query<{ team_id: string }>(
      `SELECT tm.team_id FROM team_members tm
       WHERE tm.user_id = $1
         AND (SELECT count(*) FROM team_members x WHERE x.team_id = tm.team_id) = 1`,
      [id],
    );
    for (const t of soleTeams.rows) await cancelTeamStripeSubscription(t.team_id);
    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM users WHERE id = $1', [id]); // team_members cascade
      if (soleTeams.rows.length > 0) {
        await tx.query('DELETE FROM teams WHERE id = ANY($1)', [soleTeams.rows.map((t) => t.team_id)]);
      }
    });
    void auditFromReq(req, 'user.delete', { teamId: null, target: target.rows[0].email, detail: { userId: id, soleTeamsRemoved: soleTeams.rows.length } });
    return reply.code(204).send();
  });

  // Delete any team — verified customers included (this is deliberate; the
  // admin asked to be able to remove any team, not only abandoned signups).
  // Two guardrails only: the team must exist, and it must not contain a
  // platform admin (which also stops the admin nuking their own team and
  // locking themselves out). Any Stripe subscription is cancelled first so a
  // deleted paying team doesn't keep getting billed.
  app.delete('/admin/teams/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const team = await query<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = $1', [id]);
    if (team.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
    const hasAdmin = await query<{ one: number }>(
      `SELECT 1 AS one FROM team_members tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 AND u.is_platform_admin LIMIT 1`,
      [id],
    );
    if (hasAdmin.rowCount && hasAdmin.rowCount > 0) {
      return reply.code(400).send({ error: 'has_admin', detail: 'Refusing to delete a team that contains a platform admin.' });
    }
    await cancelTeamStripeSubscription(id);
    await withTransaction(async (tx) => {
      const members = await tx.query<{ user_id: string }>('SELECT user_id FROM team_members WHERE team_id = $1', [id]);
      await tx.query('DELETE FROM teams WHERE id = $1', [id]);
      // Purge any member this leaves orphaned (no other team) AND unverified —
      // otherwise their email stays "taken" with no team behind it. A verified
      // user keeps their account even if this was their only team.
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
    // teamId: null — the team row is gone, so anchor the record at platform
    // level (with the name in target) instead of losing it to the cascade.
    void auditFromReq(req, 'team.delete', { teamId: null, target: team.rows[0].name, detail: { teamId: id } });
    return reply.code(204).send();
  });

  // Platform-wide audit log — every recorded action, newest first.
  app.get('/admin/audit', { preHandler: requirePlatformAdmin }, async () => {
    const res = await query<AuditRow>(
      `SELECT id, action, target, actor_email, detail, created_at, team_id
       FROM audit_log ORDER BY created_at DESC LIMIT 100`,
    );
    return { entries: res.rows.map(serializeAudit) };
  });

  app.get('/admin/overview', { preHandler: requirePlatformAdmin }, async () => {
    const [teams, activeSubs, starts, failures, newTeams, running, queued] = await Promise.all([
      query<{ count: string }>('SELECT count(*) FROM teams'),
      query<{ count: string }>("SELECT count(*) FROM subscriptions WHERE status IN ('active', 'trialing')"),
      query<{ count: string }>(
        "SELECT count(*) FROM usage_events WHERE event_type = 'start' AND occurred_at > now() - interval '7 days'",
      ),
      query<{ count: string }>(
        "SELECT count(*) FROM usage_events WHERE event_type = 'start_failed' AND occurred_at > now() - interval '7 days'",
      ),
      query<{ count: string }>("SELECT count(*) FROM teams WHERE created_at > now() - interval '7 days'"),
      query<{ count: string }>("SELECT count(*) FROM environment_requests WHERE status = 'assigned'"),
      query<{ count: string }>("SELECT count(*) FROM environment_requests WHERE status IN ('queued', 'assigning')"),
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
    // Pooled image-cache hit rate: sum hits / sum lookups across all hosts
    // that have reported cache counters (NULL for hosts whose registry debug
    // endpoint is off). Null when no host has reported any lookups yet.
    // reporting = hosts that actually publish cache counters (registry debug
    // endpoint on + agent scraping it); surfaced so "—" can be diagnosed as
    // "no host reporting" vs. "reporting, but nothing pulled yet".
    const cache = await query<{ lookups: string | null; hits: string | null; reporting: string }>(
      `SELECT sum(cache_lookups) AS lookups, sum(cache_hits) AS hits,
              count(*) FILTER (WHERE cache_lookups IS NOT NULL) AS reporting
       FROM hosts`,
    );
    const startCount = Number(starts.rows[0].count);
    const failCount = Number(failures.rows[0].count);
    const cacheLookups = Number(cache.rows[0].lookups ?? 0);
    const cacheHits = Number(cache.rows[0].hits ?? 0);
    const cacheReportingHosts = Number(cache.rows[0].reporting);
    // MRR split by tier, so the number isn't just one opaque total.
    const mrrByTier = mrr.rows
      .map((r) => {
        const plan = getPlan(r.plan_tier);
        const count = Number(r.count);
        return { tier: r.plan_tier, label: plan.label, count, chfEach: plan.chfMonthly, chfTotal: plan.chfMonthly * count };
      })
      .sort((a, b) => b.chfTotal - a.chfTotal);
    return {
      totalTeams: Number(teams.rows[0].count),
      newTeams7d: Number(newTeams.rows[0].count),
      activeSubscriptions: Number(activeSubs.rows[0].count),
      mrrChf: mrrByTier.reduce((sum, r) => sum + r.chfTotal, 0),
      mrrByTier,
      vmStarts7d: startCount,
      vmStartFailures7d: failCount,
      vmStartErrorRate7d: startCount + failCount > 0 ? failCount / (startCount + failCount) : null,
      runningEnvironments: Number(running.rows[0].count),
      queuedEnvironments: Number(queued.rows[0].count),
      // Real pooled cache hit rate from the hosts' registry proxies; null
      // until at least one host reports lookups.
      cacheHitRate: cacheLookups > 0 ? cacheHits / cacheLookups : null,
      cacheReportingHosts,
      cacheLookups,
      dataPlaneConnected: Number(connected.rows[0].count) > 0,
    };
  });

  // Recent activity feed for the overview: latest signups and the most recent
  // failed VM starts (the two things an admin most wants to notice quickly).
  app.get('/admin/activity', { preHandler: requirePlatformAdmin }, async () => {
    const [signups, failures] = await Promise.all([
      query<{ id: string; name: string; plan_tier: PlanTier; created_at: string; owner_email: string | null; owner_verified: boolean | null }>(
        `SELECT t.id, t.name, t.plan_tier, t.created_at,
                (SELECT u.email FROM team_members tm JOIN users u ON u.id = tm.user_id
                   WHERE tm.team_id = t.id AND tm.role = 'owner' LIMIT 1) AS owner_email,
                (SELECT u.email_verified_at IS NOT NULL FROM team_members tm JOIN users u ON u.id = tm.user_id
                   WHERE tm.team_id = t.id AND tm.role = 'owner' LIMIT 1) AS owner_verified
         FROM teams t ORDER BY t.created_at DESC LIMIT 8`,
      ),
      query<{ id: string; team_name: string; vm_id: string | null; occurred_at: string }>(
        `SELECT ue.id, t.name AS team_name, ue.vm_id, ue.occurred_at
         FROM usage_events ue JOIN teams t ON t.id = ue.team_id
         WHERE ue.event_type = 'start_failed'
         ORDER BY ue.occurred_at DESC LIMIT 8`,
      ),
    ]);
    return {
      recentSignups: signups.rows.map((s) => ({
        id: s.id, name: s.name, planLabel: getPlan(s.plan_tier).label,
        ownerEmail: s.owner_email, ownerVerified: s.owner_verified ?? false, createdAt: s.created_at,
      })),
      recentFailures: failures.rows.map((f) => ({
        id: f.id, teamName: f.team_name, vmId: f.vm_id, occurredAt: f.occurred_at,
      })),
    };
  });

  // Daily activity for the overview chart: VM starts, failed starts, and new
  // signups per day over the last `days` (default 14, capped at 90).
  app.get('/admin/timeseries', { preHandler: requirePlatformAdmin }, async (req) => {
    const raw = Number((req.query as { days?: string }).days ?? 14);
    const days = Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.trunc(raw))) : 14;
    // generate_series gives a row per day even when nothing happened, so the
    // chart has no gaps. All in UTC to match the rest of the status tooling.
    const res = await query<{ day: string; starts: string; failures: string; signups: string }>(
      `WITH d AS (
         SELECT generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
                                date_trunc('day', now()), interval '1 day') AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM usage_events ue WHERE ue.event_type = 'start'
                 AND ue.occurred_at >= d.day AND ue.occurred_at < d.day + interval '1 day') AS starts,
              (SELECT count(*) FROM usage_events ue WHERE ue.event_type = 'start_failed'
                 AND ue.occurred_at >= d.day AND ue.occurred_at < d.day + interval '1 day') AS failures,
              (SELECT count(*) FROM teams t WHERE t.created_at >= d.day AND t.created_at < d.day + interval '1 day') AS signups
       FROM d ORDER BY d.day`,
      [days],
    );
    return {
      days: res.rows.map((r) => ({
        date: r.day, starts: Number(r.starts), failures: Number(r.failures), signups: Number(r.signups),
      })),
    };
  });
}
