import type { FastifyRequest } from 'fastify';
import { query } from '../db.js';

/**
 * Append one audit-log entry. Deliberately best-effort and fire-and-forget:
 * an audit-write failure must never break the action being audited, so callers
 * `void recordAudit(...)` and errors are swallowed (logged). Pass teamId=null
 * for platform-level actions whose team is being deleted, so the record isn't
 * removed by the team's ON DELETE CASCADE.
 */
export async function recordAudit(opts: {
  teamId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (team_id, actor_user_id, actor_email, action, target, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [opts.teamId, opts.actorUserId, opts.actorEmail, opts.action, opts.target ?? null, opts.detail ?? {}],
    );
  } catch (err) {
    console.error('[audit] failed to record', opts.action, err);
  }
}

/** Convenience for the common case: the actor is the authenticated user on the
 *  request. `req.user` is present for every session/admin route. */
export function auditFromReq(
  req: FastifyRequest,
  action: string,
  opts: { teamId?: string | null; target?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  const teamId = opts.teamId !== undefined ? opts.teamId : (req.membership?.teamId ?? null);
  return recordAudit({
    teamId,
    actorUserId: req.user?.id ?? null,
    actorEmail: req.user?.email ?? null,
    action,
    target: opts.target,
    detail: opts.detail,
  });
}

export interface AuditRow {
  id: string; action: string; target: string | null; actor_email: string | null;
  detail: Record<string, unknown>; created_at: string; team_id: string | null;
}

export function serializeAudit(r: AuditRow): {
  id: string; action: string; target: string | null; actorEmail: string | null;
  detail: Record<string, unknown>; createdAt: string;
} {
  return { id: r.id, action: r.action, target: r.target, actorEmail: r.actor_email, detail: r.detail, createdAt: r.created_at };
}
