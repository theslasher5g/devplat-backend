import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { sendContactNotification } from '../lib/email.js';

/**
 * Public contact-form endpoint (the marketing site's "Book a call" / Contact
 * page) — no auth, since the visitor isn't a devplat user yet. The
 * submission is stored first and the notification email is best-effort, so
 * a Resend outage never loses the message itself.
 */
export default async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.post('/contact', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email', 'message'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          email: { type: 'string', format: 'email', maxLength: 255 },
          company: { type: 'string', maxLength: 200 },
          message: { type: 'string', minLength: 1, maxLength: 5000 },
        },
      },
    },
    // Unauthenticated + writes a DB row + sends an email on every hit — a
    // prime spam/abuse target. Tight per-IP cap; a real visitor sends one
    // message, not ten a minute.
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { name, email, company, message } = req.body as {
      name: string; email: string; company?: string; message: string;
    };
    await query(
      'INSERT INTO contact_submissions (name, email, company, message) VALUES ($1, $2, $3, $4)',
      [name.trim(), email.trim().toLowerCase(), company?.trim() || null, message.trim()],
    );
    await sendContactNotification({ name, email, company, message }).catch((err) => {
      req.log.warn({ err }, 'contact notification email failed to send');
    });
    return reply.code(201).send({ ok: true });
  });
}
