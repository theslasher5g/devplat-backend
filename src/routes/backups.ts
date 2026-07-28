import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { maybeOne, query } from '../db.js';
import { requirePlatformAdmin } from '../plugins/auth.js';

/**
 * Backup reporting.
 *
 * deploy/backup/backup.sh POSTs the outcome of every run here. That exists
 * because the dangerous backup failure isn't a loud one — it's the job that
 * quietly stopped months ago and looks identical to a working one until the
 * day the data is actually needed. With the runs recorded, the admin dashboard
 * can show freshness and the maintenance sweep can alert on silence.
 */

/** Bearer check against BACKUP_REPORT_TOKEN, constant-time. */
async function requireBackupToken(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const expected = config.backupReportToken;
  if (!expected) {
    reply.code(503).send({ error: 'backup_reporting_disabled' });
    return reply;
  }
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so compare lengths first —
  // the length itself is not the secret.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    reply.code(401).send({ error: 'invalid_backup_token' });
    return reply;
  }
}

export default async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/backup-report', {
    preHandler: requireBackupToken,
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['ok', 'failed', 'verified'] },
          archive: { type: 'string', maxLength: 200 },
          bytes: { type: 'integer', minimum: 0 },
          durationSeconds: { type: 'integer', minimum: 0 },
          detail: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (req) => {
    const body = req.body as {
      status: 'ok' | 'failed' | 'verified';
      archive?: string; bytes?: number; durationSeconds?: number; detail?: string;
    };

    await query(
      `INSERT INTO backup_runs (status, archive, bytes, duration_seconds, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [body.status, body.archive ?? null, body.bytes ?? 0, body.durationSeconds ?? 0, body.detail || null],
    );

    if (body.status === 'failed') {
      // Alert immediately rather than waiting for the staleness sweep: a run
      // that reported its own failure has already told us what went wrong,
      // and that detail is the most useful thing anyone will get.
      const { sendOpsAlert } = await import('../lib/alerts.js');
      await sendOpsAlert(
        'Database backup failed',
        `The nightly backup did not complete.\n\n${body.detail || '(no detail reported)'}\n\n`
        + 'Check /var/log/devplat-backup.log on the VPS. Until this is fixed there is no fresh copy of the database.',
        ':rotating_light:',
      ).catch((err: unknown) => req.log.error({ err }, 'backup failure alert could not be sent'));
    } else {
      // A success re-arms the staleness alert for the next outage.
      await query('UPDATE platform_settings SET backup_alerted_at = NULL WHERE id = 1');
    }

    return { received: true };
  });

  // Backup health for the admin dashboard.
  app.get('/admin/backups', { preHandler: requirePlatformAdmin }, async () => {
    const runs = await query<{
      id: string; status: string; archive: string | null; bytes: string;
      duration_seconds: number; detail: string | null; created_at: string;
    }>(
      `SELECT id, status, archive, bytes, duration_seconds, detail, created_at
       FROM backup_runs ORDER BY created_at DESC LIMIT 20`,
    );
    const latest = await maybeOne<{ created_at: string; bytes: string }>(
      "SELECT created_at, bytes FROM backup_runs WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1",
    );
    const verified = await maybeOne<{ created_at: string }>(
      "SELECT created_at FROM backup_runs WHERE status = 'verified' ORDER BY created_at DESC LIMIT 1",
    );
    return {
      configured: Boolean(config.backupReportToken),
      lastSuccessAt: latest?.created_at ?? null,
      lastSuccessBytes: latest ? Number(latest.bytes) : null,
      lastVerifiedAt: verified?.created_at ?? null,
      runs: runs.rows.map((r) => ({
        id: r.id,
        status: r.status,
        archive: r.archive,
        bytes: Number(r.bytes),
        durationSeconds: r.duration_seconds,
        detail: r.detail,
        createdAt: r.created_at,
      })),
    };
  });
}
