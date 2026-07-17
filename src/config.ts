export type PlanTier = 'free' | 'solo' | 'team' | 'scale';

// Plan/tier data (prices, parallelism, per-environment resource caps) lives in
// the `plans` DB table and is accessed via src/plans.ts — not hardcoded here.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  // Per-VM sizing is no longer a global constant — it's the requesting team's
  // plan cap (vcpu_per_environment / ram_gb_per_environment), looked up per
  // request in the scheduler. See src/plans.ts and src/scheduler/allocator.ts.
  // How many seconds an agent may go without a heartbeat before the
  // scheduler marks its host offline and stops assigning new VMs to it.
  agentHeartbeatTimeoutSeconds: Number(process.env.AGENT_HEARTBEAT_TIMEOUT_SECONDS ?? 90),
  // Poll interval for the queue worker (retrying queued environment
  // requests as capacity frees up) and the host health-check loop.
  schedulerPollIntervalMs: Number(process.env.SCHEDULER_POLL_INTERVAL_MS ?? 5000),
  frontendUrl: (process.env.FRONTEND_URL ?? 'https://devplat.ch').replace(/\/$/, ''),
  apiUrl: (process.env.API_URL ?? 'https://api.devplat.ch').replace(/\/$/, ''),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  isProd: process.env.NODE_ENV !== 'development' && !process.env.DEV,
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.EMAIL_FROM ?? 'devplat <noreply@devplat.dev>',
  // Where "Book a call" / contact-form submissions are sent as a notification.
  contactEmail: process.env.CONTACT_EMAIL ?? 'hello@devplat.dev',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  stripePrices: {
    solo: { monthly: process.env.STRIPE_PRICE_SOLO_MONTHLY ?? '', yearly: process.env.STRIPE_PRICE_SOLO_YEARLY ?? '' },
    team: { monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY ?? '', yearly: process.env.STRIPE_PRICE_TEAM_YEARLY ?? '' },
    scale: { monthly: process.env.STRIPE_PRICE_SCALE_MONTHLY ?? '', yearly: process.env.STRIPE_PRICE_SCALE_YEARLY ?? '' },
  } as Record<Exclude<PlanTier, 'free'>, { monthly: string; yearly: string }>,
};

/** Reverse lookup: which tier/interval does a Stripe price id belong to? */
export function tierForPrice(priceId: string): { tier: Exclude<PlanTier, 'free'>; interval: 'monthly' | 'yearly' } | null {
  for (const tier of ['solo', 'team', 'scale'] as const) {
    if (config.stripePrices[tier].monthly === priceId) return { tier, interval: 'monthly' };
    if (config.stripePrices[tier].yearly === priceId) return { tier, interval: 'yearly' };
  }
  return null;
}
