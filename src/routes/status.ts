import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { maybeOne, query, withTransaction } from '../db.js';
import { sendStatusConfirmEmail, sendStatusNotifyEmail } from '../lib/email.js';
import { attachUpdates, getStatusSummary, type PostRow } from '../lib/status.js';
import { generateOneTimeToken, hashToken } from '../lib/tokens.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

const TYPE_LABEL: Record<string, string> = { incident: 'Incident', maintenance: 'Maintenance', announcement: 'Announcement' };

/** Fire-and-forget: email every confirmed subscriber about a status event.
 *  Best-effort — a Resend outage must not fail the admin's action. */
async function notifySubscribers(kicker: string, title: string, body: string): Promise<void> {
  const subs = await query<{ email: string; unsubscribe_token: string }>(
    'SELECT email, unsubscribe_token FROM status_subscribers WHERE confirmed_at IS NOT NULL',
  );
  await Promise.allSettled(subs.rows.map((s) =>
    sendStatusNotifyEmail(s.email, { kicker, title, body, unsubscribeToken: s.unsubscribe_token })));
}

// Allowed lifecycle states per post type, and which of them mean "this post is
// over" (sets resolved_at, moving it from active to history).
const STATES: Record<string, string[]> = {
  incident: ['investigating', 'identified', 'monitoring', 'resolved'],
  maintenance: ['scheduled', 'in_progress', 'completed'],
  announcement: ['published'],
};
const TERMINAL = new Set(['resolved', 'completed']);
const DEFAULT_STATE: Record<string, string> = { incident: 'investigating', maintenance: 'scheduled', announcement: 'published' };
const DEFAULT_IMPACT: Record<string, string> = { incident: 'minor', maintenance: 'maintenance', announcement: 'none' };
const COMPONENT_STATUSES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'];

export default async function statusRoutes(app: FastifyInstance): Promise<void> {
  // ---- Public: the status page + the dashboard panel both read this ----
  // ?historyDays=N includes the per-component daily uptime bars; ?before=ISO
  // ends the window earlier (date-range paging on the status page).
  app.get('/status', async (req) => {
    const q = req.query as { historyDays?: string; before?: string };
    const historyDays = q.historyDays ? Math.max(0, Math.min(365, parseInt(q.historyDays, 10) || 0)) : 0;
    const before = q.before ? new Date(q.before) : undefined;
    return getStatusSummary({ historyDays, before: before && !isNaN(before.getTime()) ? before : undefined });
  });

  // ---- Admin: components ----
  app.get('/admin/status/components', { preHandler: requirePlatformAdmin }, async () => {
    const rows = await query<{ id: string; key: string; name: string; source: string; manual_status: string | null; position: number; group_name: string | null }>(
      'SELECT id, key, name, source, manual_status, position, group_name FROM status_components ORDER BY position, name',
    );
    return { components: rows.rows.map((c) => ({ id: c.id, key: c.key, name: c.name, source: c.source, manualStatus: c.manual_status, position: c.position, groupName: c.group_name })) };
  });

  // Set/clear a manual status (override for derived components, the value for
  // manual ones), rename, reorder, or assign to a group.
  app.patch('/admin/status/components/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { manualStatus?: string | null; name?: string; position?: number; groupName?: string | null };
    if (body.manualStatus !== undefined && body.manualStatus !== null && !COMPONENT_STATUSES.includes(body.manualStatus)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.manualStatus !== undefined) { fields.push(`manual_status = $${fields.length + 1}`); values.push(body.manualStatus); }
    if (body.name !== undefined) { fields.push(`name = $${fields.length + 1}`); values.push(body.name); }
    if (body.position !== undefined) { fields.push(`position = $${fields.length + 1}`); values.push(body.position); }
    if (body.groupName !== undefined) { fields.push(`group_name = $${fields.length + 1}`); values.push(body.groupName || null); }
    if (fields.length === 0) return reply.code(400).send({ error: 'no_fields' });
    values.push(id);
    const found = await maybeOne(`UPDATE status_components SET ${fields.join(', ')}, updated_at = now() WHERE id = $${fields.length + 1} RETURNING id`, values);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Add a manual component (e.g. "Registry cache") the admin sets by hand,
  // optionally under a group.
  app.post('/admin/status/components', {
    preHandler: requirePlatformAdmin,
    schema: { body: { type: 'object', required: ['key', 'name'], properties: {
      key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9-]+$' },
      name: { type: 'string', minLength: 1, maxLength: 100 },
      manualStatus: { type: 'string', enum: COMPONENT_STATUSES },
      position: { type: 'integer' },
      groupName: { type: 'string', maxLength: 100 },
    } } },
  }, async (req, reply) => {
    const b = req.body as { key: string; name: string; manualStatus?: string; position?: number; groupName?: string };
    const exists = await maybeOne('SELECT 1 FROM status_components WHERE key = $1', [b.key]);
    if (exists) return reply.code(409).send({ error: 'key_taken' });
    const row = await query<{ id: string }>(
      `INSERT INTO status_components (key, name, source, manual_status, position, group_name)
       VALUES ($1, $2, 'manual', $3, $4, $5) RETURNING id`,
      [b.key, b.name, b.manualStatus ?? 'operational', b.position ?? 100, b.groupName || null],
    );
    return reply.code(201).send({ id: row.rows[0].id });
  });

  // Only manual components can be deleted; the derived 'api'/'compute' rows are
  // structural.
  app.delete('/admin/status/components/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await maybeOne("DELETE FROM status_components WHERE id = $1 AND source = 'manual' RETURNING id", [id]);
    if (!found) return reply.code(404).send({ error: 'not_found_or_not_deletable' });
    return { ok: true };
  });

  // ---- Admin: posts (incidents / maintenance / announcements) ----
  app.get('/admin/status/posts', { preHandler: requirePlatformAdmin }, async () => {
    const rows = await query<PostRow>('SELECT * FROM status_posts ORDER BY created_at DESC');
    return { posts: await attachUpdates(rows.rows) };
  });

  app.post('/admin/status/posts', {
    preHandler: requirePlatformAdmin,
    schema: { body: { type: 'object', required: ['type', 'title'], properties: {
      type: { type: 'string', enum: ['incident', 'maintenance', 'announcement'] },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', maxLength: 5000 },
      impact: { type: 'string', enum: ['none', 'minor', 'major', 'critical', 'maintenance'] },
      state: { type: 'string' },
      affectedComponents: { type: 'array', items: { type: 'string', maxLength: 64 } },
      scheduledStart: { type: 'string' },
      scheduledEnd: { type: 'string' },
    } } },
  }, async (req, reply) => {
    const b = req.body as {
      type: string; title: string; body?: string; impact?: string; state?: string;
      affectedComponents?: string[]; scheduledStart?: string; scheduledEnd?: string;
    };
    const state = b.state ?? DEFAULT_STATE[b.type];
    if (!STATES[b.type].includes(state)) return reply.code(400).send({ error: 'invalid_state_for_type' });
    const resolvedAt = TERMINAL.has(state) ? new Date().toISOString() : null;
    const row = await query<{ id: string }>(
      `INSERT INTO status_posts (type, title, body, impact, state, affected_components, scheduled_start, scheduled_end, created_by, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.type, b.title, b.body ?? '', b.impact ?? DEFAULT_IMPACT[b.type], state,
        b.affectedComponents ?? [], b.scheduledStart ?? null, b.scheduledEnd ?? null, req.user.id, resolvedAt],
    );
    // Notify subscribers of the new post (fire-and-forget).
    void notifySubscribers(`${TYPE_LABEL[b.type]} · ${state.replace(/_/g, ' ')}`, b.title, b.body ?? '')
      .catch((err) => req.log.warn({ err }, 'status: subscriber notify failed'));
    return reply.code(201).send({ id: row.rows[0].id });
  });

  // Edit a post's fields. Passing a new state re-derives resolved_at (so
  // reopening a resolved incident clears it, and resolving sets it).
  app.patch('/admin/status/posts/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      title?: string; body?: string; impact?: string; state?: string;
      affectedComponents?: string[]; scheduledStart?: string | null; scheduledEnd?: string | null;
    };
    const post = await maybeOne<{ type: string }>('SELECT type FROM status_posts WHERE id = $1', [id]);
    if (!post) return reply.code(404).send({ error: 'not_found' });
    if (b.state !== undefined && !STATES[post.type].includes(b.state)) return reply.code(400).send({ error: 'invalid_state_for_type' });

    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => { fields.push(`${col} = $${fields.length + 1}`); values.push(val); };
    if (b.title !== undefined) set('title', b.title);
    if (b.body !== undefined) set('body', b.body);
    if (b.impact !== undefined) set('impact', b.impact);
    if (b.affectedComponents !== undefined) set('affected_components', b.affectedComponents);
    if (b.scheduledStart !== undefined) set('scheduled_start', b.scheduledStart);
    if (b.scheduledEnd !== undefined) set('scheduled_end', b.scheduledEnd);
    if (b.state !== undefined) {
      set('state', b.state);
      set('resolved_at', TERMINAL.has(b.state) ? new Date().toISOString() : null);
    }
    if (fields.length === 0) return reply.code(400).send({ error: 'no_fields' });
    values.push(id);
    await query(`UPDATE status_posts SET ${fields.join(', ')}, updated_at = now() WHERE id = $${fields.length + 1}`, values);
    return { ok: true };
  });

  // Add a threaded update, optionally moving the post to a new state (the
  // status-page pattern: "Identified — root cause is …", "Resolved — …").
  app.post('/admin/status/posts/:id/updates', {
    preHandler: requirePlatformAdmin,
    schema: { body: { type: 'object', required: ['body'], properties: {
      body: { type: 'string', minLength: 1, maxLength: 5000 },
      state: { type: 'string' },
    } } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { body: string; state?: string };
    const post = await maybeOne<{ type: string; title: string }>('SELECT type, title FROM status_posts WHERE id = $1', [id]);
    if (!post) return reply.code(404).send({ error: 'not_found' });
    if (b.state !== undefined && !STATES[post.type].includes(b.state)) return reply.code(400).send({ error: 'invalid_state_for_type' });

    await withTransaction(async (tx) => {
      await tx.query(
        'INSERT INTO status_post_updates (post_id, state, body, created_by) VALUES ($1, $2, $3, $4)',
        [id, b.state ?? null, b.body, req.user.id],
      );
      if (b.state !== undefined) {
        await tx.query(
          'UPDATE status_posts SET state = $1, resolved_at = $2, updated_at = now() WHERE id = $3',
          [b.state, TERMINAL.has(b.state) ? new Date().toISOString() : null, id],
        );
      } else {
        await tx.query('UPDATE status_posts SET updated_at = now() WHERE id = $1', [id]);
      }
    });
    const kicker = b.state ? `${TYPE_LABEL[post.type]} · ${b.state.replace(/_/g, ' ')}` : `Update · ${TYPE_LABEL[post.type]}`;
    void notifySubscribers(kicker, post.title, b.body)
      .catch((err) => req.log.warn({ err }, 'status: subscriber notify failed'));
    return reply.code(201).send({ ok: true });
  });

  app.delete('/admin/status/posts/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await maybeOne('DELETE FROM status_posts WHERE id = $1 RETURNING id', [id]);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ---- Public: email subscriptions (double opt-in) ----
  app.post('/status/subscribe', {
    // A DB write + outbound email per call; cap per IP so it can't be used to
    // mail-bomb an address via the confirmation mail.
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email', maxLength: 255 } } } },
  }, async (req, reply) => {
    const email = (req.body as { email: string }).email.trim().toLowerCase();
    const existing = await maybeOne<{ confirmed_at: string | null }>('SELECT confirmed_at FROM status_subscribers WHERE email = $1', [email]);
    // Already confirmed → say ok without re-sending (and without revealing it).
    if (existing?.confirmed_at) return reply.send({ ok: true });

    const { token, hash } = generateOneTimeToken();
    if (existing) {
      await query('UPDATE status_subscribers SET confirm_token_hash = $1 WHERE email = $2', [hash, email]);
    } else {
      await query(
        'INSERT INTO status_subscribers (email, confirm_token_hash, unsubscribe_token) VALUES ($1, $2, $3)',
        [email, hash, randomBytes(24).toString('base64url')],
      );
    }
    await sendStatusConfirmEmail(email, token).catch((err) => req.log.warn({ err }, 'status: confirm email failed'));
    return reply.send({ ok: true });
  });

  app.post('/status/confirm', {
    schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req, reply) => {
    const { token } = req.body as { token: string };
    // Idempotent: keep the token so a refresh / double-fire (or React's
    // dev-mode double effect) confirms again cleanly instead of 404-ing.
    const row = await maybeOne<{ id: string }>(
      `UPDATE status_subscribers SET confirmed_at = COALESCE(confirmed_at, now())
       WHERE confirm_token_hash = $1 RETURNING id`,
      [hashToken(token)],
    );
    if (!row) return reply.code(404).send({ error: 'invalid_or_used_token' });
    return { ok: true };
  });

  app.post('/status/unsubscribe', {
    schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req) => {
    // Idempotent: unknown/again-used token still returns ok so the link never
    // errors and we don't reveal whether an address was subscribed.
    await query('DELETE FROM status_subscribers WHERE unsubscribe_token = $1', [(req.body as { token: string }).token]);
    return { ok: true };
  });
}
