// ============================================================
// EMAIL TEMPLATES - EDIT YOUR EMAILS HERE
// ============================================================
// Every automated email the app sends is written in this one file, so you can
// change the wording without touching any other code. Each template has:
//   subject(ctx) -> the subject line
//   body(ctx)    -> the HTML body
// The `ctx` object gives you the data listed above each template. Edit the
// text freely; keep the ${...} placeholders where you want live values.
//
// After editing, restart the server for changes to take effect.

const BLUE = '#003f87';
const GOLD = '#fdb913';

// Escape user-typed values (names, subjects, message bodies) so they can't
// inject HTML into the email. Keep the e(...) wrappers around anything a user
// can type.
const e = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Shared wrapper so every email gets the same header/footer. `appUrl` comes
// from the APP_URL environment variable (falls back to a plain sign-off).
function layout(title, inner, appUrl) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f6f7;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-top:4px solid ${BLUE};border-radius:6px;overflow:hidden;">
      <div style="padding:18px 24px;border-bottom:1px solid #f1f5f9;">
        <span style="font-size:16px;font-weight:800;color:${BLUE};">State High FBLA</span>
      </div>
      <div style="padding:20px 24px;color:#111827;font-size:14px;line-height:1.55;">
        <h2 style="margin:0 0 12px;font-size:18px;color:${BLUE};">${title}</h2>
        ${inner}
      </div>
      <div style="padding:14px 24px;border-top:1px solid #f1f5f9;font-size:12px;color:#6b7280;">
        ${appUrl ? `<a href="${appUrl}" style="color:${BLUE};font-weight:700;">Open the chapter hub</a> &middot; ` : ''}
        Sent automatically by your chapter's FBLA Hub. Questions? Contact an officer.
      </div>
    </div>
  </div>`;
}

module.exports = {
  // ----------------------------------------------------------
  // TEST EMAIL (sent from Settings to check the credentials work)
  // ctx: { sent_by, app_url }
  // ----------------------------------------------------------
  test: {
    subject: () => 'FBLA Hub test email',
    body: (ctx) => layout(
      'Email is working',
      `<p style="margin:0;">This is a test from the FBLA Hub${ctx.sent_by ? `, sent by ${e(ctx.sent_by)}` : ''}. If you're reading this, the email credentials are set up correctly.</p>`,
      ctx.app_url
    ),
  },

  // ----------------------------------------------------------
  // PASSWORD RESET CODE
  // Sent when an officer taps "Forgot password?" on the officer sign-in.
  // ctx: { name, code, expires_min, app_url }
  // ----------------------------------------------------------
  reset_code: {
    subject: (ctx) => `${ctx.code} is your FBLA Hub password reset code`,
    body: (ctx) => layout(
      'Reset your password',
      `
      <p style="margin:0 0 14px;">Hi ${ctx.name ? e(ctx.name.split(' ')[0]) : 'there'}, here is your password reset code:</p>
      <div style="text-align:center;margin:6px 0 16px;">
        <span style="display:inline-block;padding:12px 26px;border-radius:8px;background:#f4f6fb;border:1px solid #dfe4ef;font-size:28px;font-weight:800;letter-spacing:.35em;color:${BLUE};">${ctx.code}</span>
      </div>
      <p style="margin:0 0 6px;">Type it into the sign-in page to choose a new password. The code works for ${ctx.expires_min} minutes and only once.</p>
      <p style="margin:0;color:#6b7280;font-size:12.5px;">If you didn't ask for this, you can ignore this email; your password stays the same.</p>
      `,
      ctx.app_url
    ),
  },

  // ----------------------------------------------------------
  // OFFICER ACCOUNT CREATED
  // ctx: { name, role_label, created_by, app_url }
  // ----------------------------------------------------------
  officer_account: {
    subject: (ctx) => `Your FBLA officer account is ready (${ctx.role_label})`,
    body: (ctx) => layout(
      'Your officer account is ready',
      `
      <p style="margin:0 0 10px;">Hi ${ctx.name ? e(ctx.name.split(' ')[0]) : 'there'}, ${ctx.created_by ? e(ctx.created_by) + ' set up' : 'the chapter set up'} an officer account for you with the role of <strong>${e(ctx.role_label)}</strong>.</p>
      <p style="margin:0 0 10px;">Open the chapter hub, choose <strong>Officer sign in</strong> at the bottom of the menu, and sign in with your name and the password you were given.</p>
      <p style="margin:0;color:#6b7280;font-size:12.5px;">Forgot the password? Use "Forgot password?" on the sign-in page and a reset code will come to this address.</p>
      `,
      ctx.app_url
    ),
  },

  // ----------------------------------------------------------
  // OFFICER-COMPOSED EMAIL (the Email tab in the officer console)
  // Whatever an officer types, wrapped in the chapter's email design.
  // ctx: { member_name (the recipient's name), subject, body, sent_by, greet, app_url }
  // `body` is plain text; line breaks are kept and HTML is escaped, so an
  // officer can never paste markup into anyone's inbox.
  // ----------------------------------------------------------
  custom: {
    subject: (ctx) => ctx.subject,
    body: (ctx) => layout(
      e(ctx.subject),
      `
      ${ctx.greet && ctx.member_name ? `<p style="margin:0 0 12px;">Hi ${e(String(ctx.member_name).split(' ')[0])},</p>` : ''}
      <div style="white-space:pre-wrap;">${e(ctx.body)}</div>
      ${ctx.sent_by ? `<p style="margin:16px 0 0;color:#6b7280;font-size:12.5px;">Sent by ${e(ctx.sent_by)} for State High FBLA</p>` : ''}
      `,
      ctx.app_url
    ),
  },
};
