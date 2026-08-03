import { config } from '../config.js';
import { sendHostOfflineEmail, sendOpsEmail } from './email.js';
import { sanitizeAlertSubject } from './sanitize.js';

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

/**
 * Generic ops alert: email plus Slack, same best-effort fan-out as above.
 * `emoji` only affects the Slack line; the body is carried as written.
 *
 * The subject is sanitised here rather than at each call site. Callers pass
 * strings built from host names, routes and error text, and remembering to
 * clean each one is the kind of rule that holds until the next alert is added.
 */
export async function sendOpsAlert(
  rawSubject: string,
  body: string,
  emoji = ':warning:',
): Promise<void> {
  const subject = sanitizeAlertSubject(rawSubject);
  const results = await Promise.allSettled([
    sendOpsEmail(`[devplat ops] ${subject}`, body),
    postSlack(`${emoji} *${subject}*\n${body}`),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[alerts] ops-alert channel failed', r.reason);
  }
}
