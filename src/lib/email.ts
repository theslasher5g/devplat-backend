import { render } from '@react-email/render';
import { Resend } from 'resend';
import type { ReactElement } from 'react';
import { config } from '../config.js';
import ContactSubmission from '../emails/ContactSubmission.js';
import ResetPassword from '../emails/ResetPassword.js';
import TeamInvite from '../emails/TeamInvite.js';
import VerifyEmail from '../emails/VerifyEmail.js';

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

/** Notifies the contact inbox of a new "Book a call" / contact-form submission.
 *  Best-effort: the caller already persisted the submission, so a Resend
 *  outage here loses the notification, not the submission itself. */
export async function sendContactNotification(payload: {
  name: string; email: string; company?: string; message: string;
}): Promise<void> {
  await send(config.contactEmail, `New contact form message from ${payload.name}`, ContactSubmission(payload));
}
