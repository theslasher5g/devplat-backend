import type { FastifyInstance } from 'fastify';
import { maybeOne, query } from '../db.js';
import { sendOpsAlert } from '../lib/alerts.js';
import { sanitizeAlertSubject } from '../lib/sanitize.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

/**
 * Enterprise enquiries: the entry point for the tier that has no checkout.
 *
 * The top plan is sold by conversation, which is the whole reason it has no
 * published price — it is how we find out what a regulated customer will
 * actually pay, a number nobody currently knows. That only works if the
 * conversation can start, so this is the form on the pricing page.
 *
 * Public, and unauthenticated on purpose. The most valuable enquiry comes from
 * someone evaluating us before they have signed up for anything; requiring an
 * account first would filter out exactly those. That makes it spam-facing, so
 * it is rate limited, schema-bounded, and every free-text field that reaches an
 * alert subject goes through the same sanitiser as the error tracker (see
 * lib/sanitize.ts for the attack that made that necessary).
 */
export default async function enquiryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/enquiries', {
    // Tighter than the contact form: a genuine buyer sends one of these, not
    // five. Loose enough that a company behind one NAT can send a few.
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'company'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 200 },
          company: { type: 'string', minLength: 1, maxLength: 200 },
          teamSize: { type: 'integer', minimum: 1, maximum: 100_000 },
          message: { type: 'string', maxLength: 4000 },
          source: { type: 'string', enum: ['pricing', 'dashboard'] },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const b = req.body as {
      email: string; company: string; teamSize?: number; message?: string; source?: string;
    };
    if (!b.email.includes('@')) {
      return reply.code(400).send({ error: 'invalid_email', detail: 'That does not look like an email address.' });
    }

    // Attach the enquiry to a team when the sender happens to be signed in.
    // Optional by design — see the note above about who the best enquiries come
    // from — but when it is there it turns "someone asked" into "this account
    // asked", which is the difference between a lead and a conversation.
    const teamId = req.membership?.teamId ?? null;

    const row = await query<{ id: string }>(
      `INSERT INTO enterprise_enquiries (team_id, email, company, team_size, message, source)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [teamId, b.email.trim(), b.company.trim(), b.teamSize ?? null, b.message?.trim() || null, b.source ?? 'pricing'],
    );

    // Stored first, then alerted. If the mail fails the enquiry still exists in
    // the admin view; if it were the other way round a Resend outage would lose
    // the lead entirely.
    await sendOpsAlert(
      sanitizeAlertSubject(`Enterprise enquiry — ${b.company.trim()}`),
      `${b.company.trim()} (${b.email.trim()})\n`
      + `Team size: ${b.teamSize ?? 'not given'}\n`
      + `Source: ${b.source ?? 'pricing'}\n\n`
      + `${b.message?.trim() || '(no message)'}\n\n`
      + 'Open the admin dashboard under Enquiries to mark it handled.',
      ':handshake:',
    ).catch((err: unknown) => console.error('[enquiries] alert failed', err));

    return reply.code(201).send({
      id: row.rows[0].id,
      ok: true,
      detail: 'Thanks — we will come back to you within one working day.',
    });
  });

  app.get('/admin/enquiries', { preHandler: requirePlatformAdmin }, async (req) => {
    const q = req.query as { status?: string };
    const status = ['new', 'contacted', 'won', 'lost'].includes(q.status ?? '') ? q.status! : null;
    const res = await query<{
      id: string; email: string; company: string; team_size: number | null; message: string | null;
      source: string; status: string; created_at: string; handled_at: string | null;
      team_name: string | null;
    }>(
      `SELECT e.id, e.email, e.company, e.team_size, e.message, e.source, e.status,
              e.created_at, e.handled_at, t.name AS team_name
       FROM enterprise_enquiries e
       LEFT JOIN teams t ON t.id = e.team_id
       WHERE ($1::text IS NULL OR e.status = $1)
       ORDER BY (e.status = 'new') DESC, e.created_at DESC
       LIMIT 200`,
      [status],
    );
    return {
      enquiries: res.rows.map((e) => ({
        id: e.id,
        email: e.email,
        company: e.company,
        teamSize: e.team_size,
        message: e.message,
        source: e.source,
        status: e.status,
        createdAt: e.created_at,
        handledAt: e.handled_at,
        teamName: e.team_name,
      })),
    };
  });

  app.patch('/admin/enquiries/:id', {
    preHandler: requirePlatformAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: ['new', 'contacted', 'won', 'lost'] } },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: string };
    const updated = await maybeOne<{ id: string }>(
      `UPDATE enterprise_enquiries
       SET status = $2,
           -- Stamped when it leaves 'new' and cleared if it goes back, so the
           -- column always answers "when did someone deal with this" rather
           -- than "when was it last touched".
           handled_at = CASE WHEN $2 = 'new' THEN NULL ELSE COALESCE(handled_at, now()) END
       WHERE id = $1 RETURNING id`,
      [id, status],
    );
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
