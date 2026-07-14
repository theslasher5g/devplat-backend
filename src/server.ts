import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import teamRoutes from './routes/teams.js';
import tokenRoutes from './routes/tokens.js';
import webhookRoutes from './routes/webhooks.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    trustProxy: true, // behind Traefik
  });

  await app.register(cors, {
    origin: [config.frontendUrl, 'http://localhost:5173'],
    credentials: true,
  });
  await app.register(cookie);

  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error & { code?: string; statusCode?: number; validation?: unknown };
    // Malformed uuid path params etc. are client errors, not 500s.
    if (err.code === '22P02') {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    if (err.validation) {
      return reply.code(400).send({ error: 'validation_failed', detail: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    const clientError = typeof err.statusCode === 'number' && err.statusCode < 500;
    return reply.code(clientError ? err.statusCode! : 500)
      .send({ error: clientError ? err.message : 'internal_error' });
  });

  app.get('/health', async () => ({ ok: true, service: 'devplat-api' }));

  await app.register(authRoutes);
  await app.register(teamRoutes);
  await app.register(tokenRoutes);
  await app.register(billingRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);

  return app;
}
