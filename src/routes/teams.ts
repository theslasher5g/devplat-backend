import type { FastifyInstance } from 'fastify';
import { config, type PlanTier } from '../config.js';
import { maybeOne, one, query, withTransaction } from '../db.js';
import { getPlan, maxFootprintGb } from '../plans.js';
import { type AuditRow, auditFromReq, serializeAudit } from '../lib/audit.js';
import { sendTeamInviteEmail } from '../lib/email.js';
import { getOrCreateReferralCode } from '../lib/referral.js';
import { stripe } from '../lib/stripe.js';
import { generateOneTimeToken, hashToken } from '../lib/tokens.js';
import { SESSION_COOKIE, requireApiTokenOrUser, requireMember, requireTeamAdmin, requireUser, sessionCookieOptions } from '../plugins/auth.js';

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
    return { teams };
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
    const teamId = await withTransaction(async (tx) => {
      const t = await tx.query<{ id: string }>(
        trialDays
          ? "INSERT INTO teams (name, trial_ends_at) VALUES ($1, now() + ($2 || ' days')::interval) RETURNING id"
          : 'INSERT INTO teams (name) VALUES ($1) RETURNING id',
        trialDays ? [name.trim(), String(trialDays)] : [name.trim()],
      );
      const id = t.rows[0].id;
      await tx.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')", [id, req.user.id]);
      // Land the user in the team they just made, rather than leaving them in
      // whichever one the fallback would have picked.
      await tx.query('UPDATE users SET active_team_id = $1 WHERE id = $2', [id, req.user.id]);
      return id;
    });
    await auditFromReq(req, 'team.create', { teamId, target: name.trim() });
    return reply.code(201).send({ ok: true, teamId });
  });

  app.get('/teams/me', { preHandler: requireMember }, async (req) => {
    // Entitlement view: the effective tier (a manual plan_override if set, else
    // the billing plan_tier) drives the caps shown here. The billing plan and
    // its subscription state live under /billing/subscription.
    const team = await one<{ id: string; name: string; plan_tier: PlanTier; trial_ends_at: string; created_at: string }>(
      'SELECT id, name, COALESCE(plan_override, plan_tier) AS plan_tier, trial_ends_at, created_at FROM teams WHERE id = $1',
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
    const res = await query<AuditRow>(
      `SELECT id, action, target, actor_email, detail, created_at, team_id
       FROM audit_log WHERE team_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.membership.teamId],
    );
    return { entries: res.rows.map(serializeAudit) };
  });

  app.patch('/teams/me', {
    preHandler: requireTeamAdmin,
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } },
  }, async (req) => {
    const { name } = req.body as { name: string };
    await query('UPDATE teams SET name = $1 WHERE id = $2', [name.trim(), req.membership.teamId]);
    await auditFromReq(req, 'team.rename', { target: name.trim() });
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
