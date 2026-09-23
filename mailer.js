// ============================================================
// Chapter email (Resend or SMTP via nodemailer)
// ============================================================
// The email TEXT lives in email-templates.js - edit it there.
//
// CREDENTIALS (add to .env; email is skipped until then):
//   ResendAPI=re_...                   (preferred), or
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
//   MAIL_FROM="State High FBLA <chapter@yourdomain.com>"   (optional)
//   APP_URL=https://your-site.com      (optional, used for links in emails)
//
// V2 keeps no student accounts, so no email ever goes to a student from here.
// What is sent:
//   - an officer's password reset code (when switched on in the Email tab)
//   - a note to a new officer that their account exists
//   - a test email, and one-off emails an officer writes to the officer team
//     from the Email tab (sendCustomEmail)

const nodemailer = require('nodemailer');
const templates = require('./email-templates');

const APP_URL = process.env.APP_URL || '';
const DIGEST_HOUR = Number(process.env.EMAIL_DIGEST_HOUR) || 7;
// Resend REST endpoint. Overridable so tests can point at a local mock server.
const RESEND_BASE = process.env.RESEND_BASE_URL || 'https://api.resend.com';

// Two supported transports, checked in order:
//   1. Resend (https://resend.com): set ResendAPI (or RESEND_API_KEY) in .env.
//      Until you verify your own domain in Resend, use the default from address
//      below (onboarding@resend.dev) - it can only deliver to the email that
//      owns the Resend account, which is perfect for testing. Once your domain
//      is verified, set MAIL_FROM="State High FBLA <hub@yourdomain.com>".
//   2. SMTP via nodemailer: SMTP_HOST/SMTP_USER/SMTP_PASS (see header above).
function resendKey() {
  return (process.env.ResendAPI || process.env.RESEND_API_KEY || '').trim();
}
function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
function isConfigured() {
  return !!resendKey() || smtpConfigured();
}
function fromAddress() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  if (resendKey()) return 'State High FBLA <onboarding@resend.dev>';
  return process.env.SMTP_USER;
}

let transport = null;
function getTransport() {
  if (!smtpConfigured()) return null;
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

async function sendViaResend(to, subject, html) {
  const res = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Resend rejected the email (HTTP ${res.status})${body.message ? ': ' + body.message : ''}`);
  }
  return res.json();
}

async function sendMail(to, subject, html) {
  if (resendKey()) return sendViaResend(to, subject, html);
  const t = getTransport();
  if (!t) throw new Error('Email is not configured yet. Add ResendAPI (or SMTP credentials) to the environment.');
  return t.sendMail({ from: fromAddress(), to, subject, html });
}

async function sendTemplate(to, name, ctx) {
  const tpl = templates[name];
  if (!tpl) throw new Error(`No email template named "${name}"`);
  return sendMail(to, tpl.subject(ctx), tpl.body({ ...ctx, app_url: APP_URL }));
}

// ============================================================
// Officer-composed email (the Email tab)
// ============================================================
// Recipients are resolved HERE, from the database, and never taken from the
// browser. With no student accounts the only audience is the active officer
// team (every officer account with an email on file).
async function resolveRecipients(db, opts = {}) {
  const mode = opts.mode || 'officers';
  if (mode !== 'officers') throw new Error('Emails can only go to the officer team.');
  const officers = await db.listOfficers();
  return officers.filter(o => o.active && o.email).map(o => ({ id: o.id, name: o.name || 'Officer', email: o.email }));
}

// One address per person: the same address can sit on two officer records, so
// a message never lands twice in one inbox.
function dedupeRecipients(list) {
  const seen = new Set();
  return list.filter(r => {
    const key = String(r.email || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Send an officer's own message. `preview: true` resolves the audience and
// returns it WITHOUT sending, so the Email tab can show exactly who would get
// it before anything leaves the building.
async function sendCustomEmail(db, opts = {}) {
  const subject = String(opts.subject || '').trim();
  const body = String(opts.body || '').trim();
  if (!opts.preview) {
    if (!isConfigured()) throw new Error('Email is not set up yet. Add a Resend key or SMTP credentials first.');
    if (!subject) throw new Error('Give the email a subject.');
    if (!body) throw new Error('Write a message before sending.');
  }
  const recipients = dedupeRecipients(await resolveRecipients(db, opts));
  if (opts.preview) return { preview: true, total: recipients.length, recipients };
  if (!recipients.length) throw new Error('Nobody in that group has an email address on file.');

  let sent = 0, failed = 0, firstError = null;
  for (const r of recipients) {
    try {
      await sendTemplate(r.email, 'custom', {
        member_name: r.name,
        subject,
        body,
        sent_by: opts.sent_by || null,
        greet: opts.greet !== false,
      });
      sent++;
    } catch (e) {
      failed++;
      if (!firstError) firstError = e.message;
      console.error(`[mail] officer email to ${r.email} failed:`, e.message);
    }
  }
  return { sent, failed, total: recipients.length, error: firstError };
}

async function sendTestEmail(to, sentBy) {
  await sendTemplate(to, 'test', { sent_by: sentBy || null });
  return { ok: true };
}

function status() {
  return {
    configured: isConfigured(),
    transport: resendKey() ? 'resend' : (smtpConfigured() ? 'smtp' : null),
    from: isConfigured() ? fromAddress() : null,
  };
}

module.exports = {
  isConfigured, sendMail, sendTemplate, sendTestEmail,
  sendCustomEmail, resolveRecipients, status,
  // Pure helper, exported for the unit tests.
  dedupeRecipients,
};
