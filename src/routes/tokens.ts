import type { FastifyInstance } from 'fastify';
import { maybeOne, query } from '../db.js';
import { generateApiToken } from '../lib/tokens.js';
import { requireMember } from '../plugins/auth.js';

export default async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tokens', { preHandler: requireMember }, async (req) => {
    const res = await query<{
      id: string; label: string; token_prefix: string; scope: string;
      created_at: string; last_used_at: string | null;
    }>(
      `SELECT id, label, token_prefix, scope, created_at, last_used_at
       FROM api_tokens WHERE team_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [req.membership.teamId],
    );
    return {
      tokens: res.rows.map((t) => ({
        id: t.id,
        label: t.label,
        prefix: t.token_prefix,
        scope: t.scope,
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
      })),
    };
  });

  app.post('/tokens', {
    preHandler: requireMember,
    schema: {
      body: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 120 },
          scope: { type: 'string', enum: ['ci:run', 'dev:run'] },
        },
      },
    },
  }, async (req, reply) => {
    const { label, scope = 'ci:run' } = req.body as { label: string; scope?: 'ci:run' | 'dev:run' };
    const { token, hash, prefix } = generateApiToken(scope);
    const row = await query<{ id: string; created_at: string }>(
      `INSERT INTO api_tokens (team_id, label, token_prefix, scope, token_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [req.membership.teamId, label.trim(), prefix, scope, hash],
    );
    // The plaintext token is returned exactly once and never stored.
    return reply.code(201).send({
      token,
      id: row.rows[0].id,
      label: label.trim(),
      prefix,
      scope,
      createdAt: row.rows[0].created_at,
    });
  });

  app.delete('/tokens/:id', { preHandler: requireMember }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await maybeOne(
      'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL RETURNING id',
      [id, req.membership.teamId],
    );
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
