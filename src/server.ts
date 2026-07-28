import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { query } from './db.js';
import { getLatestCliVersion } from './lib/cliVersion.js';
import adminRoutes from './routes/admin.js';
import backupRoutes from './routes/backups.js';
import authRoutes from './routes/auth.js';
import deviceAuthRoutes from './routes/deviceAuth.js';
import billingRoutes from './routes/billing.js';
import contactRoutes from './routes/contact.js';
import dataExportRoutes from './routes/dataExport.js';
import environmentRoutes from './routes/environments.js';
import hostRoutes from './routes/hosts.js';
import sessionRoutes from './routes/sessions.js';
import statusRoutes from './routes/status.js';
import systemHealthRoutes from './routes/systemHealth.js';
import teamRoutes from './routes/teams.js';
import tokenRoutes from './routes/tokens.js';
import twoFactorRoutes from './routes/twofactor.js';
import tunnelRoutes from './routes/tunnel.js';
import webhookRoutes from './routes/webhooks.js';
import { loadPlans } from './plans.js';
import { startHealthPoller } from './scheduler/healthPoller.js';
import { startQueueWorker } from './scheduler/queueWorker.js';
import { startMaintenanceWorker } from './scheduler/maintenance.js';
import { startTrialNoticeWorker } from './scheduler/trialNotices.js';

/** The set of browser origins allowed to call the API with credentials: the
 *  configured frontend URL, its apex↔www counterpart, and the local dev origin.
 *  Deriving the counterpart means a deploy served at both devplat.ch and
 *  www.devplat.ch works without listing each by hand. */
function allowedOrigins(frontendUrl: string): string[] {
  const origins = new Set<string>(['http://localhost:5173']);
  try {
    const u = new URL(frontendUrl);
    origins.add(u.origin);
    // Add the www↔apex sibling of the configured host.
    const host = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
    origins.add(`${u.protocol}//${host}`);
  } catch {
    // Malformed FRONTEND_URL — fall back to just the raw string + localhost.
    origins.add(frontendUrl);
  }
  return [...origins];
}

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
    // Allow the configured frontend origin AND its apex/www counterpart: the
    // site is reachable at both https://devplat.ch and https://www.devplat.ch,
    // and a browser on the "wrong" one would otherwise have every API call
    // blocked by CORS ("API not reachable"). Cookies already span the parent
    // domain (sessionCookieOptions' domain = .devplat.ch), so accepting both
    // origins is all that's needed for login to work from either host.
    origin: allowedOrigins(config.frontendUrl),
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

  // Liveness: the process is up. Cheap, no dependencies — for load balancers.
  app.get('/health', async () => ({ ok: true, service: 'devplat-api' }));

  // Latest CLI release, proxied (and cached) from the release host so the
  // browser can read it same-origin — get.devplat.ch/version.txt itself sends
  // no CORS headers. Public: it's just a version string.
  app.get('/cli/latest-version', async (_req, reply) => {
    const version = await getLatestCliVersion();
    // Let intermediaries cache briefly; the value changes only on release.
    reply.header('cache-control', 'public, max-age=300');
    return { version };
  });

  // Readiness: can we actually serve? Checks DB connectivity and reports
  // operational signals (online hosts, queue depth) so monitoring can alert on
  // "up but can't place VMs". 503 when the DB is unreachable.
  app.get('/ready', async (req, reply) => {
    try {
      const [hosts, queue] = await Promise.all([
        query<{ online: string; draining: string }>(
          `SELECT count(*) FILTER (WHERE status = 'online' AND drain = false) AS online,
                  count(*) FILTER (WHERE drain = true) AS draining
           FROM hosts WHERE last_heartbeat > now() - ($1 || ' seconds')::interval`,
          [String(config.agentHeartbeatTimeoutSeconds)],
        ),
        query<{ queued: string }>(
          "SELECT count(*) AS queued FROM environment_requests WHERE status IN ('queued', 'assigning')",
        ),
      ]);
      const onlineHosts = Number(hosts.rows[0].online);
      return {
        ready: true,
        db: true,
        onlineHosts,
        drainingHosts: Number(hosts.rows[0].draining),
        queuedEnvironments: Number(queue.rows[0].queued),
        // A healthy API with zero usable hosts can't place any VM — surface it.
        canPlaceEnvironments: onlineHosts > 0,
      };
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ ready: false, db: false });
    }
  });

  await app.register(authRoutes);
  await app.register(twoFactorRoutes);
  await app.register(sessionRoutes);
  await app.register(deviceAuthRoutes);
  await app.register(contactRoutes);
  await app.register(dataExportRoutes);
  await app.register(teamRoutes);
  await app.register(tokenRoutes);
  await app.register(billingRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);
  await app.register(hostRoutes);
  await app.register(backupRoutes);
  await app.register(systemHealthRoutes);
  await app.register(statusRoutes);
  await app.register(environmentRoutes);
  await app.register(tunnelRoutes);

  // Scheduler background loops: retry queued environment requests as
  // capacity frees up, and poll agent health to keep hosts.status /
  // cpu_used / ram_used_mb current.
  const stopQueueWorker = startQueueWorker(config.schedulerPollIntervalMs);
  const stopHealthPoller = startHealthPoller(config.schedulerPollIntervalMs);
  // Warns owners before a free trial lapses; without it the first sign is a
  // failing pipeline once parallelism drops to zero.
  const stopTrialNotices = startTrialNoticeWorker();
  // Prunes tables that only answer questions about the recent past (sessions,
  // spent verification tokens, the Stripe replay ledger) — nothing deleted
  // from them before, so they grew for the life of the deployment.
  const stopMaintenance = startMaintenanceWorker();
  app.addHook('onClose', async () => {
    stopQueueWorker();
    stopHealthPoller();
    stopTrialNotices();
    stopMaintenance();
  });

  return app;
}
