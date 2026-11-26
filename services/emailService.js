/**
 * Sends the app's emails (verify email, reset password, sign-in link, invites, join requests).
 *
 * EMAIL_MODE=ses  -> Amazon SES (production). The server's IAM role needs ses:SendEmail.
 * EMAIL_MODE=log  -> print the email to the console instead (local development, tests).
 * Default: ses in production, log otherwise.
 *
 * Addresses that bounced or complained (auth.email_suppressions) are skipped.
 */
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const db = require('../db');

const FROM = process.env.EMAIL_FROM || 'Vision-M Studio <noreply@gsnsoln.in>';
const REPLY_TO = process.env.EMAIL_REPLY_TO || 'vision_m@gsnsoln.com';
const BRAND_URL = 'https://visionm.gsnsoln.in';

let ses = null;
function mode() {
  return process.env.EMAIL_MODE || (process.env.NODE_ENV === 'production' ? 'ses' : 'log');
}

/** Last emails sent in log mode (used by tests) */
const outbox = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;color:#1f2723">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px">
<tr><td>
<h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h2>
${bodyHtml}
<p style="margin:28px 0 0;font-size:12px;color:#6b746f">GSN Solutions · <a href="${BRAND_URL}" style="color:#6b746f">visionm.gsnsoln.in</a></p>
</td></tr></table></body></html>`;
}

function button(href, label) {
  return `<p style="margin:22px 0"><a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 20px;background:#202725;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${escapeHtml(label)}</a></p>
<p style="font-size:12px;color:#6b746f">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">${escapeHtml(href)}</span></p>`;
}

async function isSuppressed(email) {
  try {
    const row = await db.one('select 1 from auth.email_suppressions where email = lower($1)', [email]);
    return !!row;
  } catch (err) {
    console.warn('[email] suppression check failed, sending anyway:', err.message);
    return false;
  }
}

/** Send one email. Returns { sent: boolean, reason? } and never throws for delivery problems. */
async function sendEmail({ to, subject, html, text }) {
  if (!to) return { sent: false, reason: 'no recipient' };
  if (await isSuppressed(to)) {
    console.warn(`[email] not sending to suppressed address ${to}`);
    return { sent: false, reason: 'suppressed' };
  }
  if (mode() === 'log') {
    outbox.push({ to, subject, html, text, at: new Date() });
    if (outbox.length > 50) outbox.shift();
    console.log(`\n[email:log] To: ${to}\n[email:log] Subject: ${subject}\n[email:log] ${text}\n`);
    return { sent: true, mode: 'log' };
  }
  try {
    if (!ses) ses = new SESv2Client({ region: process.env.SES_REGION || 'ap-south-1' });
    await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM,
      ReplyToAddresses: [REPLY_TO],
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    }));
    return { sent: true, mode: 'ses' };
  } catch (err) {
    console.error(`[email] SES send to ${to} failed:`, err.name, err.message);
    return { sent: false, reason: err.message };
  }
}

// ---- Templates ---------------------------------------------------------------

function verifyEmail({ to, name, link }) {
  const hi = name ? `Hi ${escapeHtml(name)},` : 'Hi,';
  return sendEmail({
    to,
    subject: 'Confirm your email for Vision-M Studio',
    html: layout('Confirm your email', `<p>${hi}</p><p>Thanks for signing up for Vision-M Studio. Please confirm your email address to finish creating your account. This link expires in 24 hours.</p>${button(link, 'Confirm email')}<p>If you didn't sign up, you can ignore this email.</p>`),
    text: `${name ? `Hi ${name},` : 'Hi,'}\n\nConfirm your email for Vision-M Studio (link expires in 24 hours):\n${link}\n\nIf you didn't sign up, ignore this email.`,
  });
}

function resetPassword({ to, name, link }) {
  const hi = name ? `Hi ${escapeHtml(name)},` : 'Hi,';
  return sendEmail({
    to,
    subject: 'Reset your Vision-M Studio password',
    html: layout('Reset your password', `<p>${hi}</p><p>We received a request to reset the password for your Vision-M Studio account. This link works once and expires in 1 hour.</p>${button(link, 'Choose a new password')}<p>If you didn't ask for this, you can ignore this email; your password won't change.</p>`),
    text: `${name ? `Hi ${name},` : 'Hi,'}\n\nReset your Vision-M Studio password (link works once, expires in 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
  });
}

function magicLogin({ to, link }) {
  return sendEmail({
    to,
    subject: 'Your Vision-M Studio sign-in link',
    html: layout('Sign in to Vision-M Studio', `<p>Use this link to sign in. It works once and expires in 1 hour.</p>${button(link, 'Sign in')}<p>If you didn't ask for this, you can ignore this email.</p>`),
    text: `Sign in to Vision-M Studio (link works once, expires in 1 hour):\n${link}`,
  });
}

function organisationInvite({ to, companyName, inviterName, link }) {
  const who = inviterName ? escapeHtml(inviterName) : 'An admin';
  return sendEmail({
    to,
    subject: `You're invited to join ${companyName} on Vision-M Studio`,
    html: layout(`Join ${companyName}`, `<p>${who} invited you to join the organisation <strong>${escapeHtml(companyName)}</strong> on Vision-M Studio. The invite expires in 24 hours.</p>${button(link, 'Accept invite')}<p>If you weren't expecting this, you can ignore this email.</p>`),
    text: `${inviterName || 'An admin'} invited you to join ${companyName} on Vision-M Studio (expires in 24 hours):\n${link}`,
  });
}

function joinRequestToAdmin({ to, requesterName, requesterEmail, companyName, link }) {
  return sendEmail({
    to,
    subject: `Join request for ${companyName}`,
    html: layout('New join request', `<p><strong>${escapeHtml(requesterName || 'Someone')}</strong> (${escapeHtml(requesterEmail || '')}) asked to join <strong>${escapeHtml(companyName)}</strong>.</p><p>Sign in to approve or reject the request.</p>${button(link, 'Review request')}`),
    text: `${requesterName || 'Someone'} (${requesterEmail || ''}) asked to join ${companyName}. Review it here:\n${link}`,
  });
}

function joinRequestApproved({ to, name, companyName, link }) {
  const hi = name ? `Hi ${escapeHtml(name)},` : 'Hi,';
  return sendEmail({
    to,
    subject: `You've joined ${companyName} on Vision-M Studio`,
    html: layout('Request approved', `<p>${hi}</p><p>Your request to join <strong>${escapeHtml(companyName)}</strong> has been approved.</p>${button(link, 'Open Vision-M Studio')}`),
    text: `Your request to join ${companyName} on Vision-M Studio was approved:\n${link}`,
  });
}

module.exports = {
  sendEmail,
  verifyEmail,
  resetPassword,
  magicLogin,
  organisationInvite,
  joinRequestToAdmin,
  joinRequestApproved,
  outbox,
  escapeHtml,
};
