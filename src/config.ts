export type PlanTier = 'free' | 'solo' | 'team' | 'scale';

export const PLAN_LIMITS: Record<PlanTier, { parallelEnvs: number; chfMonthly: number; label: string }> = {
  free: { parallelEnvs: 1, chfMonthly: 0, label: 'Free Trial' },
  solo: { parallelEnvs: 2, chfMonthly: 29, label: 'Solo' },
  team: { parallelEnvs: 5, chfMonthly: 79, label: 'Team' },
  scale: { parallelEnvs: 15, chfMonthly: 199, label: 'Scale' },
};

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
  // Per-VM resource allocation used for capacity math (least-loaded host
  // selection, free-slot estimates). Matches the devplat-agent default —
  // keep the two in sync if either changes.
  vmVcpus: Number(process.env.VM_VCPUS ?? 1),
  vmRamMb: Number(process.env.VM_RAM_MB ?? 2048),
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
