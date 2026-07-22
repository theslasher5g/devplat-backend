import type { FastifyInstance } from 'fastify';
import { maybeOne, query, withTransaction } from '../db.js';
import { attachUpdates, getStatusSummary, type PostRow } from '../lib/status.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

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
    const rows = await query<{ id: string; key: string; name: string; source: string; manual_status: string | null; position: number }>(
      'SELECT id, key, name, source, manual_status, position FROM status_components ORDER BY position, name',
    );
    return { components: rows.rows.map((c) => ({ id: c.id, key: c.key, name: c.name, source: c.source, manualStatus: c.manual_status, position: c.position })) };
  });

  // Set/clear a manual status (override for derived components, the value for
  // manual ones), rename, or reorder.
  app.patch('/admin/status/components/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { manualStatus?: string | null; name?: string; position?: number };
    if (body.manualStatus !== undefined && body.manualStatus !== null && !COMPONENT_STATUSES.includes(body.manualStatus)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.manualStatus !== undefined) { fields.push(`manual_status = $${fields.length + 1}`); values.push(body.manualStatus); }
    if (body.name !== undefined) { fields.push(`name = $${fields.length + 1}`); values.push(body.name); }
    if (body.position !== undefined) { fields.push(`position = $${fields.length + 1}`); values.push(body.position); }
    if (fields.length === 0) return reply.code(400).send({ error: 'no_fields' });
    values.push(id);
    const found = await maybeOne(`UPDATE status_components SET ${fields.join(', ')}, updated_at = now() WHERE id = $${fields.length + 1} RETURNING id`, values);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Add a manual component (e.g. "Registry cache") the admin sets by hand.
  app.post('/admin/status/components', {
    preHandler: requirePlatformAdmin,
    schema: { body: { type: 'object', required: ['key', 'name'], properties: {
      key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9-]+$' },
      name: { type: 'string', minLength: 1, maxLength: 100 },
      manualStatus: { type: 'string', enum: COMPONENT_STATUSES },
      position: { type: 'integer' },
    } } },
  }, async (req, reply) => {
    const b = req.body as { key: string; name: string; manualStatus?: string; position?: number };
    const exists = await maybeOne('SELECT 1 FROM status_components WHERE key = $1', [b.key]);
    if (exists) return reply.code(409).send({ error: 'key_taken' });
    const row = await query<{ id: string }>(
      `INSERT INTO status_components (key, name, source, manual_status, position)
       VALUES ($1, $2, 'manual', $3, $4) RETURNING id`,
      [b.key, b.name, b.manualStatus ?? 'operational', b.position ?? 100],
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
    const post = await maybeOne<{ type: string }>('SELECT type FROM status_posts WHERE id = $1', [id]);
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
    return reply.code(201).send({ ok: true });
  });

  app.delete('/admin/status/posts/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await maybeOne('DELETE FROM status_posts WHERE id = $1 RETURNING id', [id]);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
