import { config } from '../config.js';
import { sendHostOfflineEmail } from './email.js';

/** Fan an ops alert out to every configured channel. Each channel is
 *  independent and best-effort: one failing (Resend down, Slack webhook 500)
 *  must not swallow the others or bubble up into the scheduler loop that
 *  called us. */
async function postSlack(text: string): Promise<void> {
  if (!config.slackAlertWebhookUrl) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(config.slackAlertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** A host has gone offline: email ops and (if configured) ping Slack. Both
 *  channels run regardless of the other's outcome; failures are logged, never
 *  thrown, so the health poller keeps ticking. */
export async function sendHostOfflineAlert(host: {
  name: string; location: string; lastHeartbeat: string | null;
}): Promise<void> {
  const lastHeartbeat = host.lastHeartbeat ?? 'never';
  const results = await Promise.allSettled([
    sendHostOfflineEmail({ hostName: host.name, location: host.location, lastHeartbeat }),
    postSlack(`:red_circle: *devplat host offline* — \`${host.name}\` (${host.location}) stopped heartbeating. Last seen: ${lastHeartbeat}. No new environments will land on it until it recovers.`),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[alerts] host-offline channel failed', r.reason);
  }
}
