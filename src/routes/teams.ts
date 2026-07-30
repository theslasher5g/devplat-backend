import type { FastifyInstance } from 'fastify';
import { config, type PlanTier } from '../config.js';
import { maybeOne, one, query, withTransaction } from '../db.js';
import { getPlan, maxFootprintGb } from '../plans.js';
import { resolveTtlMinutes } from '../scheduler/allocator.js';
import { type AuditRow, auditFromReq, serializeAudit } from '../lib/audit.js';
import { AUDIT_CSV_HEADER, auditCsvRow, auditFilters } from '../lib/auditExport.js';
import { sendTeamInviteEmail, sendTwoFactorRequiredEmail } from '../lib/email.js';
import { getOrCreateReferralCode } from '../lib/referral.js';
import { stripe } from '../lib/stripe.js';
import { notifyOwnershipTransferred } from '../lib/securityEvents.js';
import { generateOneTimeToken, hashToken } from '../lib/tokens.js';
import { SESSION_COOKIE, requireApiTokenOrUser, requireMember, requireTeamAdmin, requireUser, sessionCookieOptions } from '../plugins/auth.js';

/**
 * How many teams one person may own.
 *
 * With the trial bound to the user (see migration 036) there is no longer a
 * prize for creating teams in bulk, so this is hygiene rather than the defence:
 * it bounds audit noise, stray rows and invite spam from a compromised account.
 * Generous enough that an agency running separate teams per client never
 * notices; low enough that a script can't leave thousands behind.
 */
const MAX_OWNED_TEAMS = 5;

/** Thrown inside the create-team transaction so a refused check rolls back
 *  everything with it, rather than leaving a half-made team behind. */
class TeamLimitReached extends Error {}
class PaidPlanRequired extends Error {}

/**
 * Whether this user may create another team, and why not.
 *
 * The rule is that a *second* team is a paid feature. Someone with no team at
 * all can always make one — otherwise anyone who left or was removed from their
 * only team would be stranded — and a customer with a paid team can run several.
 * What isn't allowed is a free account creating a second team.
 *
 * The earlier fix here bound the trial to the user, so a second team came into
 * existence already expired. That closed the billing hole but left a worse
 * experience behind: a dead team sitting in the switcher that cannot start
 * anything, with no explanation until someone tries. Refusing the creation says
 * the same thing at the moment it can still be acted on. Joining a team you were
 * invited to is unaffected — that path never touches this.
 *
 * "Paid" is the effective tier, so a manually granted plan_override counts.
 * Callers must hold the user's row lock (see the create handler) for the counts
 * to be safe against concurrent creates.
 */
async function teamCreationBlocker(
  tx: { query: <T extends object>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
): Promise<'team_limit_reached' | 'paid_plan_required' | null> {
  const counts = await tx.query<{ owned: string; paid: string }>(
    `SELECT count(*) AS owned,
            count(*) FILTER (WHERE COALESCE(t.plan_override, t.plan_tier) <> 'free') AS paid
     FROM team_members tm JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = $1 AND tm.role = 'owner'`,
    [userId],
  );
  const owned = Number(counts.rows[0].owned);
  const paid = Number(counts.rows[0].paid);

  if (owned === 0) return null; // never strand an account with no team
  if (owned >= MAX_OWNED_TEAMS) return 'team_limit_reached';
  if (paid === 0) return 'paid_plan_required';
  return null;
}

/**
 * Seat cap check for a team's tier. Counts current members plus outstanding
 * invites, so a team can't quietly exceed its plan by sending a batch of
 * invites that all get accepted later. Returns an error body to send, or null
 * when there's room for `adding` more people.
 */
async function seatLimitError(
  teamId: string,
  adding: number,
): Promise<{ error: string; detail: string } | null> {
  const team = await maybeOne<{ plan_tier: PlanTier }>(
    'SELECT COALESCE(plan_override, plan_tier) AS plan_tier FROM teams WHERE id = $1', [teamId],
  );
  if (!team) return null;
  const plan = getPlan(team.plan_tier);
  if (plan.maxMembers === null) return null; // unlimited tier

  const counts = await one<{ members: string; invites: string }>(
    `SELECT (SELECT count(*) FROM team_members WHERE team_id = $1) AS members,
            (SELECT count(*) FROM team_invites
              WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > now()) AS invites`,
    [teamId],
  );
  const used = Number(counts.members) + Number(counts.invites);
  if (used + adding <= plan.maxMembers) return null;
  return {
    error: 'seat_limit_reached',
    detail: `The ${plan.label} plan includes ${plan.maxMembers} seat${plan.maxMembers === 1 ? '' : 's'} `
      + `(${counts.members} member${counts.members === '1' ? '' : 's'}, ${counts.invites} pending invite${counts.invites === '1' ? '' : 's'}). `
      + 'Upgrade the plan to add more people.',
  };
}

export default async function teamRoutes(app: FastifyInstance): Promise<void> {
  // Every team this user belongs to, with the one they're currently acting in
  // flagged. Deliberately uses requireUser, not requireMember: a user with no
  // team at all must still be able to see that (and then create one).
  app.get('/teams', { preHandler: requireUser }, async (req) => {
    const res = await query<{
      id: string; name: string; role: string; plan_tier: PlanTier; created_at: string;
      members: string; is_active: boolean;
    }>(
      `SELECT t.id, t.name, tm.role, COALESCE(t.plan_override, t.plan_tier) AS plan_tier,
              tm.created_at,
              (SELECT count(*) FROM team_members x WHERE x.team_id = t.id) AS members,
              (t.id = u.active_team_id) AS is_active
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN users u ON u.id = tm.user_id
       WHERE tm.user_id = $1
       ORDER BY tm.created_at`,
      [req.user.id],
    );
    const teams = res.rows.map((t) => ({
      id: t.id, name: t.name, role: t.role,
      planTier: t.plan_tier, planLabel: getPlan(t.plan_tier).label,
      members: Number(t.members), joinedAt: t.created_at, active: t.is_active,
    }));
    // Mirror requireMember's fallback so the UI highlights the same team the
    // API is actually operating on when nothing has been chosen yet.
    if (teams.length > 0 && !teams.some((t) => t.active)) teams[0].active = true;

    // The create rule is answered here rather than re-derived in the UI, so the
    // button and the endpoint can't drift apart. Same function the POST uses.
    const [me, blocked] = await Promise.all([
      one<{ trial_used: boolean }>(
        'SELECT (trial_started_at IS NOT NULL) AS trial_used FROM users WHERE id = $1', [req.user.id],
      ),
      // Read-only here, so no row lock: this is for rendering, and the POST
      // re-checks under a lock before it commits to anything.
      teamCreationBlocker({ query: (sql, params) => query(sql, params) }, req.user.id),
    ]);
    return {
      teams,
      trialAvailable: !me.trial_used,
      ownedTeams: teams.filter((t) => t.role === 'owner').length,
      maxOwnedTeams: MAX_OWNED_TEAMS,
      canCreateTeam: blocked === null,
      createBlockedReason: blocked,
    };
  });

  // Switch which team subsequent requests act in.
  app.post('/teams/switch', {
    preHandler: requireUser,
    schema: { body: { type: 'object', required: ['teamId'], properties: { teamId: { type: 'string', maxLength: 64 } } } },
  }, async (req, reply) => {
    const { teamId } = req.body as { teamId: string };
    const member = await maybeOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, req.user.id],
    );
    if (!member) return reply.code(403).send({ error: 'not_a_member' });
    await query('UPDATE users SET active_team_id = $1 WHERE id = $2', [teamId, req.user.id]);
    return { ok: true, teamId, role: member.role };
  });

  // Create a team. Without this, teams only ever came into existence during
  // registration, so anyone who left or was removed from their only team was
  // stranded on a dead account with no way back in.
  app.post('/teams', {
    preHandler: requireUser,
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } },
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { name } = req.body as { name: string };
    const trialDays = getPlan('free').trialDurationDays;

    let trialGranted = false;
    let teamId: string;
    try {
      teamId = await withTransaction(async (tx) => {
        // Lock the user's row first. Everything below counts that user's teams,
        // so without this a burst of concurrent creates would each read the same
        // pre-create counts and all pass.
        await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);

        const blocked = await teamCreationBlocker(tx, req.user.id);
        if (blocked === 'team_limit_reached') throw new TeamLimitReached();
        if (blocked === 'paid_plan_required') throw new PaidPlanRequired();

        // Claim the trial. COALESCE means the value only moves the first time;
        // comparing the result to now() then says whether THIS call was the one
        // that consumed it, because now() is the transaction timestamp and any
        // earlier claim carries a different one.
        const claim = await tx.query<{ granted: boolean }>(
          `UPDATE users SET trial_started_at = COALESCE(trial_started_at, now())
           WHERE id = $1 RETURNING (trial_started_at = now()) AS granted`,
          [req.user.id],
        );
        trialGranted = claim.rows[0]?.granted === true;

        // A team created by someone who has already used their trial starts
        // already expired rather than with no trial column set: effectivePlan()
        // treats a lapsed free team as zero parallel environments, which is
        // exactly the intended state. Reusing the existing expiry path means no
        // second notion of "not entitled" to keep in sync.
        const t = await tx.query<{ id: string }>(
          `INSERT INTO teams (name, trial_ends_at)
           VALUES ($1, CASE WHEN $2::int IS NULL THEN now() ELSE now() + ($2 || ' days')::interval END)
           RETURNING id`,
          [name.trim(), trialGranted && trialDays ? String(trialDays) : null],
        );
        const id = t.rows[0].id;
        await tx.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')", [id, req.user.id]);
        // Land the user in the team they just made, rather than leaving them in
        // whichever one the fallback would have picked.
        await tx.query('UPDATE users SET active_team_id = $1 WHERE id = $2', [id, req.user.id]);
        return id;
      });
    } catch (err) {
      if (err instanceof TeamLimitReached) {
        return reply.code(409).send({
          error: 'team_limit_reached',
          detail: `You can own up to ${MAX_OWNED_TEAMS} teams. Leave or delete one first, or write to us if you genuinely need more.`,
        });
      }
      if (err instanceof PaidPlanRequired) {
        // 402 rather than 403: nothing is forbidden about this account, a plan
        // is simply needed. Says explicitly that joining is still open, because
        // the common case behind this is someone who was invited elsewhere and
        // reached for "create" out of habit.
        return reply.code(402).send({
          error: 'paid_plan_required',
          detail: 'Running more than one team needs a paid plan. Your current team can be upgraded '
            + 'under Billing. You can still be invited to other teams and switch between them at any time.',
        });
      }
      throw err;
    }

    await auditFromReq(req, 'team.create', { teamId, target: name.trim(), detail: { trialGranted } });
    return reply.code(201).send({ ok: true, teamId, trialGranted });
  });

  app.get('/teams/me', { preHandler: requireMember }, async (req) => {
    // Entitlement view: the effective tier (a manual plan_override if set, else
    // the billing plan_tier) drives the caps shown here. The billing plan and
    // its subscription state live under /billing/subscription.
    const team = await one<{
      id: string; name: string; plan_tier: PlanTier; trial_ends_at: string; created_at: string;
      environment_ttl_minutes: number | null;
    }>(
      `SELECT id, name, COALESCE(plan_override, plan_tier) AS plan_tier, trial_ends_at, created_at,
              environment_ttl_minutes
       FROM teams WHERE id = $1`,
      [req.membership.teamId],
    );
    const members = await query<{ user_id: string; email: string; role: string; created_at: string }>(
      `SELECT tm.user_id, u.email, tm.role, tm.created_at
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 ORDER BY tm.created_at`,
      [team.id],
    );
    const invites = await query<{ id: string; email: string; role: string; expires_at: string }>(
      `SELECT id, email, role, expires_at FROM team_invites
       WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at`,
      [team.id],
    );
    return {
      team: {
        id: team.id,
        name: team.name,
        planTier: team.plan_tier,
        planLabel: getPlan(team.plan_tier).label,
        parallelLimit: getPlan(team.plan_tier).parallelEnvs,
        vcpuPerEnv: getPlan(team.plan_tier).vcpuPerEnv,
        ramGbPerEnv: getPlan(team.plan_tier).ramMbPerEnv / 1024,
        maxFootprintGb: maxFootprintGb(getPlan(team.plan_tier)),
        // Seat cap, and how much of it is already committed. Sent so the UI
        // can say "Solo is a single-seat plan" up front instead of offering an
        // invite form whose only possible outcome is an error — the server
        // still enforces this (seatLimitError), this is just so the client
        // doesn't have to guess.
        maxMembers: getPlan(team.plan_tier).maxMembers,
        seatsUsed: (members.rowCount ?? 0) + (invites.rowCount ?? 0),
        // Environment lifetime: what's in force, what the plan defaults to,
        // and how far it may be raised. Sent together so the UI can render the
        // control (and explain a fixed tier) without knowing the plan table.
        ttlMinutes: resolveTtlMinutes(getPlan(team.plan_tier), team.environment_ttl_minutes),
        ttlDefaultMinutes: getPlan(team.plan_tier).ttlDefaultMinutes,
        ttlMaxMinutes: getPlan(team.plan_tier).ttlMaxMinutes,
        trialEndsAt: team.trial_ends_at,
        createdAt: team.created_at,
        myRole: req.membership.role,
      },
      members: members.rows.map((m) => ({ userId: m.user_id, email: m.email, role: m.role, joinedAt: m.created_at })),
      pendingInvites: invites.rows.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at })),
    };
  });

  // Referral programme: the team's shareable code + link, and how many teams
  // they've referred (pending vs. rewarded with a free month). Any member can
  // see and share it.
  app.get('/teams/me/referral', { preHandler: requireMember }, async (req) => {
    const teamId = req.membership.teamId;
    const code = await getOrCreateReferralCode(teamId);
    const stats = await query<{ status: string; count: string }>(
      'SELECT status, count(*) AS count FROM referrals WHERE referrer_team_id = $1 GROUP BY status',
      [teamId],
    );
    const byStatus = Object.fromEntries(stats.rows.map((r) => [r.status, Number(r.count)]));
    return {
      code,
      shareUrl: `${config.frontendUrl}/auth?ref=${code}`,
      pending: byStatus.pending ?? 0,
      rewarded: byStatus.rewarded ?? 0,
    };
  });

  // Team activity log — visible to team admins/owners. Shows this team's own
  // audit trail (tokens, members, renames, and any admin plan override applied
  // to it), newest first.
  app.get('/teams/me/audit', { preHandler: requireTeamAdmin }, async (req) => {
    const f = auditFilters(req.query as Record<string, string | undefined>);
    const res = await query<AuditRow>(
      `SELECT id, action, target, actor_email, detail, created_at, team_id
       FROM audit_log
       WHERE team_id = $1
         AND ($2::timestamptz IS NULL OR created_at >= $2)
         AND ($3::timestamptz IS NULL OR created_at < $3)
         AND ($4::text IS NULL OR action = $4)
         AND ($5::text IS NULL OR actor_email ILIKE $5)
       ORDER BY created_at DESC
       LIMIT $6 OFFSET $7`,
      [req.membership.teamId, f.from, f.to, f.action, f.actorLike, f.limit, f.offset],
    );
    const total = await one<{ count: string }>(
      `SELECT count(*) FROM audit_log
       WHERE team_id = $1
         AND ($2::timestamptz IS NULL OR created_at >= $2)
         AND ($3::timestamptz IS NULL OR created_at < $3)
         AND ($4::text IS NULL OR action = $4)
         AND ($5::text IS NULL OR actor_email ILIKE $5)`,
      [req.membership.teamId, f.from, f.to, f.action, f.actorLike],
    );
    return { entries: res.rows.map(serializeAudit), total: Number(total.count), limit: f.limit, offset: f.offset };
  });

  // The distinct actions this team has actually recorded, so the UI can offer a
  // filter dropdown of real values instead of a hardcoded guess.
  app.get('/teams/me/audit/actions', { preHandler: requireTeamAdmin }, async (req) => {
    const res = await query<{ action: string }>(
      'SELECT DISTINCT action FROM audit_log WHERE team_id = $1 ORDER BY action',
      [req.membership.teamId],
    );
    return { actions: res.rows.map((r) => r.action) };
  });

  // Export the (filtered) trail. Compliance reviews ask for the whole record as
  // a file, not a paginated screen — CSV for spreadsheets, JSON for tooling.
  app.get('/teams/me/audit/export', {
    preHandler: requireTeamAdmin,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const f = auditFilters(q);
    const format = q.format === 'json' ? 'json' : 'csv';
    const res = await query<AuditRow>(
      `SELECT id, action, target, actor_email, detail, created_at, team_id
       FROM audit_log
       WHERE team_id = $1
         AND ($2::timestamptz IS NULL OR created_at >= $2)
         AND ($3::timestamptz IS NULL OR created_at < $3)
         AND ($4::text IS NULL OR action = $4)
         AND ($5::text IS NULL OR actor_email ILIKE $5)
       ORDER BY created_at DESC
       LIMIT 10000`,
      [req.membership.teamId, f.from, f.to, f.action, f.actorLike],
    );
    const entries = res.rows.map(serializeAudit);
    await auditFromReq(req, 'audit.export', { detail: { format, rows: entries.length } });

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="devplat-audit-${stamp}.json"`)
        .send(JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2));
    }
    const body = entries.map(auditCsvRow).join('\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="devplat-audit-${stamp}.csv"`)
      .send(AUDIT_CSV_HEADER + body + (body ? '\n' : ''));
  });

  // Team security policy. Requiring 2FA is owner-only: it can lock members out
  // of the team's resources until they enrol, which isn't an admin-level call.
  app.patch('/teams/me/security', {
    preHandler: requireMember,
    schema: {
      body: { type: 'object', required: ['requireTwoFactor'], properties: { requireTwoFactor: { type: 'boolean' } } },
    },
  }, async (req, reply) => {
    if (req.membership.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_required', detail: 'Only the team owner can change the security policy.' });
    }
    const { requireTwoFactor } = req.body as { requireTwoFactor: boolean };
    if (requireTwoFactor) {
      // Refuse to switch it on while the owner themselves has no second factor:
      // they'd immediately lock themselves out of their own team.
      const self = await one<{ has_totp: boolean }>(
        'SELECT (totp_enabled_at IS NOT NULL) AS has_totp FROM users WHERE id = $1', [req.user.id],
      );
      if (!self.has_totp) {
        return reply.code(409).send({
          error: 'enable_own_2fa_first',
          detail: 'Set up two-factor authentication on your own account before requiring it for the team.',
        });
      }
    }

    // Flip it and report whether this was an actual change, in one statement —
    // so a second PATCH with the same value can't re-notify anyone. Saving a
    // settings form twice must not mail the whole team twice.
    //
    // The `FROM teams prev` self-join is what makes that possible: RETURNING
    // sees the *new* row, so comparing against it would always look like a
    // change. The join captures the pre-update snapshot instead.
    const updated = await one<{ team_name: string; changed: boolean }>(
      `UPDATE teams t SET require_two_factor = $1
       FROM teams prev
       WHERE t.id = $2 AND prev.id = t.id
       RETURNING t.name AS team_name, (prev.require_two_factor IS DISTINCT FROM $1) AS changed`,
      [requireTwoFactor, req.membership.teamId],
    );
    await auditFromReq(req, requireTwoFactor ? 'team.2fa_required' : 'team.2fa_optional', { target: req.user.email });

    let notified = 0;
    if (requireTwoFactor && updated.changed) {
      // Tell the people this actually affects, now — otherwise the first sign
      // is a dashboard that stops working mid-task, with no idea what changed
      // or who changed it. Unverified addresses are skipped: mailing an
      // address nobody has proved they own is how a service becomes a spam
      // vector.
      const pending = await query<{ email: string }>(
        `SELECT u.email FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1
           AND u.totp_enabled_at IS NULL
           AND u.email_verified_at IS NOT NULL`,
        [req.membership.teamId],
      );
      // Settled, not sequential: one bad address must not stop the rest, and
      // awaiting them means the response only claims what actually happened.
      const results = await Promise.allSettled(
        pending.rows.map((m) => sendTwoFactorRequiredEmail(m.email, updated.team_name, req.user.email)),
      );
      notified = results.filter((r) => r.status === 'fulfilled').length;
      for (const r of results) {
        if (r.status === 'rejected') req.log.warn({ err: r.reason }, '2FA-required notice could not be sent');
      }
    }

    return { ok: true, requireTwoFactor, notified };
  });

  // Who on the team still needs to enrol — so an owner can chase people rather
  // than discovering the gap when someone is locked out.
  app.get('/teams/me/security', { preHandler: requireTeamAdmin }, async (req) => {
    const team = await one<{ require_two_factor: boolean }>(
      'SELECT require_two_factor FROM teams WHERE id = $1', [req.membership.teamId],
    );
    const members = await query<{ email: string; has_totp: boolean }>(
      `SELECT u.email, (u.totp_enabled_at IS NOT NULL) AS has_totp
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 ORDER BY u.email`,
      [req.membership.teamId],
    );
    return {
      requireTwoFactor: team.require_two_factor,
      members: members.rows.map((m) => ({ email: m.email, twoFactorEnabled: m.has_totp })),
      withoutTwoFactor: members.rows.filter((m) => !m.has_totp).length,
    };
  });

  app.patch('/teams/me', {
    preHandler: requireTeamAdmin,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          // null resets to the plan default. The schema's bounds are the widest
          // any plan allows; the per-plan ceiling is enforced below, because it
          // depends on the team's tier and a static schema can't know it.
          environmentTtlMinutes: { type: ['integer', 'null'], minimum: 5, maximum: 120 },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as { name?: string; environmentTtlMinutes?: number | null };

    if (typeof body.name === 'string') {
      await query('UPDATE teams SET name = $1 WHERE id = $2', [body.name.trim(), req.membership.teamId]);
      await auditFromReq(req, 'team.rename', { target: body.name.trim() });
    }

    if ('environmentTtlMinutes' in body) {
      const team = await one<{ plan_tier: PlanTier }>(
        'SELECT COALESCE(plan_override, plan_tier) AS plan_tier FROM teams WHERE id = $1', [req.membership.teamId],
      );
      const plan = getPlan(team.plan_tier);
      // A tier where the default already is the ceiling has nothing to
      // configure — say so rather than accepting a value that resolveTtlMinutes
      // would silently clamp back to the default.
      if (plan.ttlMaxMinutes <= plan.ttlDefaultMinutes) {
        return reply.code(409).send({
          error: 'ttl_not_configurable',
          detail: `The ${plan.label} plan runs a fixed ${plan.ttlDefaultMinutes}-minute environment lifetime. `
            + 'Team and Scale can change it.',
        });
      }
      const value = body.environmentTtlMinutes;
      if (value !== null && value !== undefined && value > plan.ttlMaxMinutes) {
        return reply.code(400).send({
          error: 'ttl_too_long',
          detail: `The ${plan.label} plan allows up to ${plan.ttlMaxMinutes} minutes.`,
        });
      }
      await query('UPDATE teams SET environment_ttl_minutes = $1 WHERE id = $2', [value ?? null, req.membership.teamId]);
      await auditFromReq(req, 'team.ttl_changed', {
        target: req.user.email,
        detail: { minutes: value ?? `plan default (${plan.ttlDefaultMinutes})` },
      });
    }

    return { ok: true };
  });

  // Self-service "delete my team" — owner only, since it also wipes every
  // member's account, not just the caller's.
  // Irreversible and owner-only; the limit is a guard against a hijacked
  // session scripting destruction, not against legitimate use.
  app.delete('/teams/me', { preHandler: requireMember, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (req.membership.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_required', detail: 'Only the team owner can delete the team.' });
    }
    const teamId = req.membership.teamId;

    // Best-effort: stop billing before the team (and its Stripe customer
    // link) disappears. A failure here is logged, not fatal — the owner's
    // right to delete their account shouldn't be blocked by Stripe being
    // briefly unreachable.
    const sub = await maybeOne<{ stripe_subscription_id: string; status: string }>(
      'SELECT stripe_subscription_id, status FROM subscriptions WHERE team_id = $1',
      [teamId],
    );
    if (sub && stripe && !['canceled', 'incomplete_expired'].includes(sub.status)) {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id).catch((err) => {
        req.log.warn({ err }, 'failed to cancel stripe subscription during team self-delete');
      });
    }

    await withTransaction(async (tx) => {
      const members = await tx.query<{ user_id: string }>('SELECT user_id FROM team_members WHERE team_id = $1', [teamId]);
      await tx.query('DELETE FROM teams WHERE id = $1', [teamId]);
      // Every member's account goes too — this is the owner deleting their
      // whole team, not admin cleanup, so verified status doesn't matter.
      // Still spared: anyone who also belongs to a different team, since
      // deleting this team shouldn't reach into a membership elsewhere.
      const memberIds = members.rows.map((m) => m.user_id);
      if (memberIds.length > 0) {
        await tx.query(
          `DELETE FROM users
             WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = users.id)`,
          [memberIds],
        );
      }
    });

    return reply.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined }).send({ ok: true });
  });

  // Parallelism limit for the (future) scheduler — reachable with an API token.
  app.get('/teams/:id/limits', { preHandler: requireApiTokenOrUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const allowedTeamId = req.apiTokenTeamId ?? req.membership.teamId;
    if (id !== allowedTeamId) return reply.code(403).send({ error: 'forbidden' });
    const team = await maybeOne<{ plan_tier: PlanTier; trial_ends_at: string }>(
      'SELECT COALESCE(plan_override, plan_tier) AS plan_tier, trial_ends_at FROM teams WHERE id = $1', [id],
    );
    if (!team) return reply.code(404).send({ error: 'not_found' });
    const trialExpired = team.plan_tier === 'free' && new Date(team.trial_ends_at) < new Date();
    const plan = getPlan(team.plan_tier);
    return {
      teamId: id,
      planTier: team.plan_tier,
      parallelEnvironments: trialExpired ? 0 : plan.parallelEnvs,
      vcpuPerEnvironment: plan.vcpuPerEnv,
      ramMbPerEnvironment: plan.ramMbPerEnv,
      trialExpired,
    };
  });

  app.post('/teams/me/invites', {
    preHandler: requireTeamAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 255 },
          role: { type: 'string', enum: ['admin', 'developer'] },
        },
      },
    },
    // Each invite sends an email to an address the caller chooses, which makes
    // this an inbox-bombing primitive if left uncapped. 20/hour is far above
    // real onboarding (even seeding a whole team) and well below useful abuse.
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { email, role = 'developer' } = req.body as { email: string; role?: 'admin' | 'developer' };
    const normalized = email.trim().toLowerCase();
    const teamId = req.membership.teamId;

    const alreadyMember = await maybeOne(
      `SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 AND u.email = $2`,
      [teamId, normalized],
    );
    if (alreadyMember) return reply.code(409).send({ error: 'already_member' });

    // Seat cap for the team's tier. Counts pending invites too, so a team
    // can't overshoot its plan by sending a batch that all get accepted.
    const seatErr = await seatLimitError(teamId, 1);
    if (seatErr) return reply.code(409).send(seatErr);

    const { token, hash } = generateOneTimeToken();
    await query('DELETE FROM team_invites WHERE team_id = $1 AND email = $2 AND accepted_at IS NULL', [teamId, normalized]);
    await query(
      `INSERT INTO team_invites (team_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
      [teamId, normalized, role, hash, req.user.id],
    );
    const team = await one<{ name: string }>('SELECT name FROM teams WHERE id = $1', [teamId]);
    await auditFromReq(req, 'member.invite', { target: normalized, detail: { role } });
    // Best-effort: the invite row is already committed above.
    await sendTeamInviteEmail(normalized, token, team.name, req.user.email, role).catch((err) => {
      req.log.warn({ err }, 'team invite email failed to send');
    });
    return reply.code(201).send({ ok: true });
  });

  // Invite details for the accept page (no auth: the token IS the credential).
  // Unauthenticated + token-in-path means this is the one place an invite token
  // could be guessed at, so cap attempts per IP. Tokens are high-entropy, but a
  // limiter turns "infeasible" into "not even worth starting".
  app.get('/invites/:token', { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    // Deliberately not filtering on accepted_at/expires_at here — an
    // already-accepted invite (e.g. auto-accepted on email verification,
    // see /auth/verify-email) needs to be told apart from a genuinely
    // invalid/expired one, so whoever re-opens the link gets "you're
    // already in" instead of a dead-end "ask for a new invite".
    const invite = await maybeOne<{
      email: string; role: string; team_name: string; accepted_at: string | null; expires_at: string;
    }>(
      `SELECT ti.email, ti.role, t.name AS team_name, ti.accepted_at, ti.expires_at
       FROM team_invites ti JOIN teams t ON t.id = ti.team_id
       WHERE ti.token_hash = $1`,
      [hashToken(token)],
    );
    const expired = !invite || (!invite.accepted_at && new Date(invite.expires_at) < new Date());
    if (expired) return reply.code(404).send({ error: 'invalid_or_expired_invite' });
    const existingUser = await maybeOne('SELECT 1 FROM users WHERE email = $1', [invite.email]);
    return {
      email: invite.email, role: invite.role, teamName: invite.team_name,
      accountExists: !!existingUser, alreadyAccepted: !!invite.accepted_at,
    };
  });

  // Withdraw a pending invitation. The dashboard listed them with no way to
  // take one back — a mistyped address would otherwise stay valid for 7 days.
  app.delete('/teams/me/invites/:id', { preHandler: requireTeamAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const gone = await maybeOne<{ email: string }>(
      'DELETE FROM team_invites WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL RETURNING email',
      [id, req.membership.teamId],
    );
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    await auditFromReq(req, 'member.invite_revoke', { target: gone.email });
    return { ok: true };
  });

  // Accept as a logged-in user whose email matches the invite.
  app.post('/invites/:token/accept', { preHandler: requireUser }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const invite = await maybeOne<{ id: string; team_id: string; email: string; role: 'admin' | 'developer' }>(
      `SELECT id, team_id, email, role FROM team_invites
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!invite) return reply.code(404).send({ error: 'invalid_or_expired_invite' });
    if (invite.email !== req.user.email) return reply.code(403).send({ error: 'invite_for_different_email' });
    // Re-check the cap at accept time: the team may have filled up, or been
    // downgraded, in the days since the invite was sent. This invite is
    // already counted in the pending total, so it isn't double-counted.
    const seatErr = await seatLimitError(invite.team_id, 0);
    if (seatErr) return reply.code(409).send(seatErr);
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [invite.team_id, req.user.id, invite.role],
      );
      await tx.query('UPDATE team_invites SET accepted_at = now() WHERE id = $1', [invite.id]);
      // Joining a team is an explicit act — make it the one they land in.
      await tx.query('UPDATE users SET active_team_id = $1 WHERE id = $2', [invite.team_id, req.user.id]);
    });
    return { ok: true, teamId: invite.team_id };
  });

  app.patch('/teams/me/members/:userId', {
    preHandler: requireTeamAdmin,
    schema: {
      body: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['admin', 'developer'] } } },
    },
  }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const { role } = req.body as { role: 'admin' | 'developer' };
    const target = await maybeOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [req.membership.teamId, userId],
    );
    if (!target) return reply.code(404).send({ error: 'not_a_member' });
    if (target.role === 'owner') return reply.code(403).send({ error: 'cannot_change_owner' });
    await query('UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3', [role, req.membership.teamId, userId]);
    return { ok: true };
  });

  // Self-service: leave the team you're in. The owner can't leave — they'd
  // orphan the team, its subscription and its billing contact — so ownership
  // has to be handed over first (or the team deleted outright).
  app.post('/teams/me/leave', {
    preHandler: requireMember,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (req.membership.role === 'owner') {
      return reply.code(409).send({
        error: 'owner_cannot_leave',
        detail: 'Transfer ownership to another member first, or delete the team.',
      });
    }
    const teamId = req.membership.teamId;
    await query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, req.user.id]);
    // Audited against the team so the remaining admins can see who left.
    await auditFromReq(req, 'member.leave', { teamId, target: req.user.email });
    return { ok: true };
  });

  // Hand the owner role to another member. The outgoing owner stays on as an
  // admin rather than being dropped, so they don't lose access by accident;
  // leaving afterwards is a separate, deliberate step.
  app.post('/teams/me/transfer-ownership', {
    preHandler: requireMember,
    schema: {
      body: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', maxLength: 64 } } },
    },
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (req.membership.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_required', detail: 'Only the current owner can transfer ownership.' });
    }
    const { userId } = req.body as { userId: string };
    if (userId === req.user.id) return reply.code(400).send({ error: 'already_owner' });
    const teamId = req.membership.teamId;
    const target = await maybeOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId],
    );
    if (!target) return reply.code(404).send({ error: 'not_a_member' });

    // Both role changes in one transaction: a team must never end up with two
    // owners or none if this fails halfway.
    await withTransaction(async (tx) => {
      await tx.query("UPDATE team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
      await tx.query("UPDATE team_members SET role = 'admin' WHERE team_id = $1 AND user_id = $2", [teamId, req.user.id]);
    });
    const newOwner = await maybeOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    await auditFromReq(req, 'team.transfer_ownership', { teamId, target: newOwner?.email ?? userId });
    // Losing ownership of a team is a change the outgoing owner should hear
    // about even if they didn't initiate it from this device.
    const team = await maybeOne<{ name: string }>('SELECT name FROM teams WHERE id = $1', [teamId]);
    notifyOwnershipTransferred(req, req.user.email, team?.name ?? 'your team', newOwner?.email ?? 'another member');
    return { ok: true };
  });

  app.delete('/teams/me/members/:userId', { preHandler: requireTeamAdmin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const target = await maybeOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [req.membership.teamId, userId],
    );
    if (!target) return reply.code(404).send({ error: 'not_a_member' });
    if (target.role === 'owner') return reply.code(403).send({ error: 'cannot_remove_owner' });
    await query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [req.membership.teamId, userId]);
    // Removing someone's access is exactly the kind of action an audit trail
    // exists for; it was the only member mutation not being recorded.
    const removed = await maybeOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    await auditFromReq(req, 'member.remove', { target: removed?.email ?? userId, detail: { role: target.role } });
    return { ok: true };
  });
}
