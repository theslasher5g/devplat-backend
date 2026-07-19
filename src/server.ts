import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import contactRoutes from './routes/contact.js';
import environmentRoutes from './routes/environments.js';
import hostRoutes from './routes/hosts.js';
import teamRoutes from './routes/teams.js';
import tokenRoutes from './routes/tokens.js';
import tunnelRoutes from './routes/tunnel.js';
import webhookRoutes from './routes/webhooks.js';
import { loadPlans } from './plans.js';
import { startHealthPoller } from './scheduler/healthPoller.js';
import { startQueueWorker } from './scheduler/queueWorker.js';

export async function buildServer(): Promise<FastifyInstance> {
  // Plan/tier data lives in the DB (plans table); load it into the typed
  // cache before any route or scheduler loop reads it. migrate() has already
  // run by the time buildServer() is called (see src/index.ts).
  await loadPlans();

  const app = Fastify({
    logger: true,
    trustProxy: true, // behind Traefik
  });

  await app.register(cors, {
    origin: [config.frontendUrl, 'http://localhost:5173'],
    credentials: true,
    // @fastify/cors defaults `methods` to 'GET,HEAD,POST' — DELETE and PATCH
    // (token/member/host revocation, team rename, environment release, ...)
    // were silently blocked by the browser's preflight for every cross-origin
    // request (frontend and API are different origins/subdomains even in
    // prod) without ever reaching this server or throwing a visible error.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(websocket);

  // Global per-IP rate limit as a blanket DoS backstop. `trustProxy` above
  // means req.ip is the real client (X-Forwarded-For from Traefik), not
  // Traefik's own address, so this keys on the actual caller. The default
  // here is deliberately generous — legitimate single-IP use (the dashboard,
  // plus the CLI polling GET /environments/:id every ~2s) stays well under
  // it; individual sensitive endpoints tighten this a lot via each route's
  // own `config.rateLimit` (see auth.ts / contact.ts). Two endpoints opt OUT
  // entirely (config.rateLimit: false): the tunnel, because a single
  // Testcontainers run legitimately opens many short-lived WebSocket
  // connections to it, and the Stripe webhook, which must never drop a
  // billing event to a limiter.
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // Reads behind the proxy correctly; skip the plugin's own warning since
    // trustProxy is intentional here.
    keyGenerator: (req) => req.ip,
  });

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
  await app.register(contactRoutes);
  await app.register(teamRoutes);
  await app.register(tokenRoutes);
  await app.register(billingRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);
  await app.register(hostRoutes);
  await app.register(environmentRoutes);
  await app.register(tunnelRoutes);

  // Scheduler background loops: retry queued environment requests as
  // capacity frees up, and poll agent health to keep hosts.status /
  // cpu_used / ram_used_mb current.
  const stopQueueWorker = startQueueWorker(config.schedulerPollIntervalMs);
  const stopHealthPoller = startHealthPoller(config.schedulerPollIntervalMs);
  app.addHook('onClose', async () => {
    stopQueueWorker();
    stopHealthPoller();
  });

  return app;
}
