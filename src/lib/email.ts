import { render } from '@react-email/render';
import { Resend } from 'resend';
import type { ReactElement } from 'react';
import { config } from '../config.js';
import ContactSubmission from '../emails/ContactSubmission.js';
import HostOfflineAlert from '../emails/HostOfflineAlert.js';
import PaymentFailed from '../emails/PaymentFailed.js';
import ResetPassword from '../emails/ResetPassword.js';
import SecurityAlert from '../emails/SecurityAlert.js';
import TrialEnding from '../emails/TrialEnding.js';
import StatusConfirm from '../emails/StatusConfirm.js';
import StatusNotify from '../emails/StatusNotify.js';
import TeamInvite from '../emails/TeamInvite.js';
import VerifyEmail from '../emails/VerifyEmail.js';
import VerifyEmailChange from '../emails/VerifyEmailChange.js';

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

async function send(to: string, subject: string, element: ReactElement, actionUrl?: string): Promise<void> {
  const html = await render(element);
  if (!resend) {
    // Local development without a Resend key: log instead of failing the request.
    console.warn(`[email] RESEND_API_KEY not set — would send "${subject}" to ${to}${actionUrl ? ` (${actionUrl})` : ''}`);
    return;
  }
  const { error } = await resend.emails.send({ from: config.emailFrom, to, subject, html });
  if (error) throw new Error(`Resend error: ${error.message}`);
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const verifyUrl = `${config.frontendUrl}/verify-email?token=${token}`;
  await send(to, 'Confirm your email address — devplat', VerifyEmail({ verifyUrl }), verifyUrl);
}

/** Sends the confirmation link to the NEW address during an email change.
 *  The change only takes effect when this link is used, so a mistyped address
 *  simply never confirms instead of locking the account away. */
export async function sendEmailChangeVerification(to: string, token: string): Promise<void> {
  const confirmUrl = `${config.frontendUrl}/confirm-email-change?token=${token}`;
  await send(to, 'Confirm your new email address — devplat', VerifyEmailChange({ confirmUrl }), confirmUrl);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;
  await send(to, 'Reset your password — devplat', ResetPassword({ resetUrl }), resetUrl);
}

export async function sendTeamInviteEmail(
  to: string, token: string, teamName: string, inviterEmail: string, role: string,
): Promise<void> {
  const inviteUrl = `${config.frontendUrl}/invite?token=${token}`;
  await send(to, `Invitation: join ${teamName} on devplat`, TeamInvite({ inviteUrl, teamName, inviterEmail, role }), inviteUrl);
}

export async function sendStatusConfirmEmail(to: string, token: string): Promise<void> {
  const confirmUrl = `${config.frontendUrl}/status/confirm?token=${token}`;
  await send(to, 'Confirm your devplat status subscription', StatusConfirm({ confirmUrl }), confirmUrl);
}

/** Notifies one confirmed subscriber of a status event. `unsubscribeToken` is
 *  the subscriber's own capability token for the one-click unsubscribe link. */
export async function sendStatusNotifyEmail(
  to: string,
  payload: { kicker: string; title: string; body: string; unsubscribeToken: string },
): Promise<void> {
  const statusUrl = `${config.frontendUrl}/status`;
  const unsubscribeUrl = `${config.frontendUrl}/status/unsubscribe?token=${payload.unsubscribeToken}`;
  await send(to, `[devplat status] ${payload.title}`,
    StatusNotify({ kicker: payload.kicker, title: payload.title, body: payload.body, statusUrl, unsubscribeUrl }));
}

/** Tells a team owner a charge failed, before the plan silently degrades.
 *  Involuntary churn — an expired card nobody noticed — is otherwise the most
 *  common way a paying customer disappears. */
export async function sendPaymentFailedEmail(to: string, payload: {
  teamName: string; amount: string; attemptsRemain: boolean;
}): Promise<void> {
  const billingUrl = `${config.frontendUrl}/app/billing`;
  await send(to, `Payment failed for ${payload.teamName} — devplat`,
    PaymentFailed({ ...payload, billingUrl }), billingUrl);
}

/** Warns a team owner that the free trial is about to lapse (or just has).
 *  Without this the first sign is a red CI pipeline. */
export async function sendTrialEndingEmail(to: string, payload: {
  teamName: string; daysLeft: number;
}): Promise<void> {
  const pricingUrl = `${config.frontendUrl}/pricing`;
  const subject = payload.daysLeft <= 0
    ? `Your devplat trial for ${payload.teamName} has ended`
    : `${payload.daysLeft} day${payload.daysLeft === 1 ? '' : 's'} left on your devplat trial`;
  await send(to, subject, TrialEnding({ ...payload, pricingUrl }), pricingUrl);
}

/** Account-security notification (new device, token created, 2FA off, ...).
 *  See lib/securityEvents.ts for the events and why each one is worth a mail. */
export async function sendSecurityAlertEmail(to: string, payload: {
  headline: string; detail: string; whenText: string; contextLines: string[]; profileUrl: string;
}): Promise<void> {
  await send(to, `[devplat security] ${payload.headline}`, SecurityAlert(payload), payload.profileUrl);
}

/** Emails the ops inbox that a host dropped out of rotation. Best-effort — the
 *  caller has already logged the transition, so a Resend outage here just loses
 *  the notification. */
export async function sendHostOfflineEmail(payload: {
  hostName: string; location: string; lastHeartbeat: string;
}): Promise<void> {
  const dashboardUrl = `${config.frontendUrl}/admin`;
  await send(config.opsAlertEmail, `[devplat ops] Host ${payload.hostName} offline`,
    HostOfflineAlert({ ...payload, dashboardUrl }));
}

/** Notifies the contact inbox of a new "Book a call" / contact-form submission.
 *  Best-effort: the caller already persisted the submission, so a Resend
 *  outage here loses the notification, not the submission itself. */
export async function sendContactNotification(payload: {
  name: string; email: string; company?: string; message: string;
}): Promise<void> {
  await send(config.contactEmail, `New contact form message from ${payload.name}`, ContactSubmission(payload));
}
