require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');
const db = require('./db');
const { parseIcs, fetchIcs } = require('./ics-import');
const mailer = require('./mailer');
const { createBackupResponseMiddleware, createGoogleSheetsBackup } = require('./google-sheets-backup');

// FBLAappV2: a public chapter hub (no student accounts, nothing to sign in to)
// plus the officer console. The ONLY accounts are officer accounts. Every
// student-facing page reads public chapter information through /api/public/*.

const sheetsBackup = createGoogleSheetsBackup({ snapshotProvider: () => db.backupJson() });
let initialBackupStarted = false;

const app = express();
const PORT = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

// In production, refuse to run on the insecure defaults baked into the source.
if (IS_PROD && (!process.env.EDIT_PASSWORD || !process.env.SESSION_SECRET)) {
  throw new Error('EDIT_PASSWORD and SESSION_SECRET must be set in production. Configure them in your hosting environment variables.');
}
// The chapter master password only exists when it is set in the environment.
// There is deliberately no fallback in the code: this repository is public.
const EDIT_PASSWORD = process.env.EDIT_PASSWORD || null;

// Small in-memory rate limiter for credential-adjacent endpoints. Sliding
// window; fine for a single-process deployment. `keyFn` lets a limiter count
// per ACCOUNT instead of per IP.
function rateLimit(max, windowMs, keyFn) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = (keyFn && keyFn(req)) || req.ip || 'unknown';
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear(); // crude memory guard
    next();
  };
}
const norm = (v) => String(v || '').trim().toLowerCase();
// Pre-auth routes count attempts against the officer ACCOUNT being targeted, so
// a brute-force run against one account stops after `max` tries.
const targetAccountKey = (req) => {
  const b = req.body || {};
  const who = norm(b.email || b.name);
  return who ? `acct:officer:${who}` : null;
};
// Signed-in password changes count per account, for the same reason.
const sessionAccountKey = (req) => (req.session && req.session.officerId) ? `officer:${req.session.officerId}` : null;
const loginLimiter = rateLimit(20, 10 * 60 * 1000, targetAccountKey);
const pwChangeLimiter = rateLimit(20, 10 * 60 * 1000, sessionAccountKey);
// Backstop: per-account keys alone would let one machine work through many
// different accounts, so an IP ceiling still applies on top.
const ipFloodLimiter = rateLimit(300, 10 * 60 * 1000);

// Lightweight observability: keep the last few server errors in memory so an
// admin can see recent failures without an external monitoring service.
const recentErrors = [];
function recordError(err, req) {
  recentErrors.unshift({
    at: new Date().toISOString(),
    message: (err && err.message) || String(err),
    path: req ? `${req.method} ${req.path}` : null,
  });
  if (recentErrors.length > 25) recentErrors.length = 25;
}

// Render/Vercel terminate TLS at a proxy; trust it so secure cookies and
// req.protocol work correctly behind the proxy.
app.set('trust proxy', 1);

// Security headers on every response: browser-side hardening against
// clickjacking, MIME sniffing, and cross-origin leakage. The officer console
// uses inline event handlers, so 'unsafe-inline' scripts are required; the
// policy still pins every external source to the exact CDNs used.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src https://www.youtube-nocookie.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieSession({
  // Its own cookie name, so a V1 session on the same host can never be read as
  // a V2 officer session.
  name: 'fblahub_v2',
  // Without SESSION_SECRET (local dev only; production refuses to start), a
  // random key is used, so sessions just don't survive a restart.
  keys: [process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex')],
  // No maxAge: a browser-session cookie, so closing the browser signs you out.
  // The signed_in_at check below adds a hard server-side cap as a backstop.
  sameSite: 'lax',
  secure: IS_PROD,
}));

// Hard server-side session cap: even if the browser keeps the session cookie
// (mobile browsers rarely "close"), a sign-in older than this is rejected.
const SESSION_MAX_HOURS = Number(process.env.SESSION_MAX_HOURS) || 12;
app.use((req, res, next) => {
  if (req.session && req.session.name) {
    const at = Number(req.session.signed_in_at) || 0;
    if (!at || Date.now() - at > SESSION_MAX_HOURS * 60 * 60 * 1000) {
      req.session = null;
    }
  }
  next();
});

// Page routes. The public hub is index.html (served by express.static below);
// the officer console is its own page.
const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/officer', sendPage('officer.html'));
// Shareable About URLs open the hub straight onto the About page. /aboutfbla is
// V1's parent-facing link; with no sign-up anywhere, both show the same page.
app.get('/about', sendPage('index.html'));
app.get('/aboutfbla', sendPage('index.html'));

// Serve the static frontend BEFORE anything touches the database, so the UI
// always loads even if the database is misconfigured.
app.use(express.static(path.join(__dirname, 'public')));

// Serverless (Vercel sets VERCEL=1) freezes the instance as soon as a response
// is sent, so Google Sheets backups there must finish BEFORE responding.
const IS_SERVERLESS = !!process.env.VERCEL;

// Only API routes need the database. Schema bootstrap is memoized in db.init().
app.use('/api', async (req, res, next) => {
  if (req.path.startsWith('/google-sheets-backup')) return next();
  try {
    await db.init();
    if (!initialBackupStarted) {
      initialBackupStarted = true;
      if (IS_SERVERLESS) {
        const status = await sheetsBackup.requestSync('process startup');
        if (status.state === 'error') console.error('Initial Google Sheets backup failed:', status.lastError);
      } else {
        sheetsBackup.requestSync('process startup')
          .then(status => { if (status.state === 'error') console.error('Initial Google Sheets backup failed:', status.lastError); })
          .catch(e => console.error('Initial Google Sheets backup failed:', e));
      }
    }
    next();
  } catch (e) {
    console.error('DB init failed:', e);
    res.status(500).json({ error: 'Database unavailable' });
  }
});

// After a successful write, snapshot the database to the Google Sheets backup.
app.use('/api', createBackupResponseMiddleware(sheetsBackup, { blocking: IS_SERVERLESS }));

// The public hub is read far more than it changes (a whole school can open it
// at once), so its bundle is cached briefly and dropped after any successful
// officer write, so an edit shows up on the very next load.
const PUBLIC_CACHE_MS = 15 * 1000;
let publicCache = null;
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => { if (res.statusCode < 400) publicCache = null; });
  }
  next();
});

// Account-backed officer sessions are checked against the database on every API
// request. Disabling/deleting an officer or changing their role therefore
// takes effect immediately.
async function refreshOfficerSession(req) {
  if (!req.session || req.session.role !== 'officer') return false;
  if (req.session.officerAuth === 'master') return true;
  if (req.session.officerAuth !== 'account' || !req.session.officerId) {
    req.session = null;
    return false;
  }
  const officer = await db.getOfficerSessionState(req.session.officerId);
  if (!officer || !officer.active) {
    req.session = null;
    return false;
  }
  req.session.name = officer.name;
  req.session.officerRole = officer.role;
  req.session.officerTitle = officer.title || null;
  req.session.canEdit = true;
  return true;
}
async function requireOfficer(req, res, next) {
  try {
    if (!req.session || !req.session.name) return res.status(401).json({ error: 'Not logged in' });
    if (req.session.role !== 'officer') return res.status(403).json({ error: 'Officer access required' });
    if (!(await refreshOfficerSession(req))) return res.status(401).json({ error: 'Session is no longer valid' });
    next();
  } catch (e) { next(e); }
}
const isAdmin = (req) => req.session.officerRole === 'president' || req.session.officerRole === 'advisor';
// President/Advisor-level actions (managing officer accounts and their
// passwords). The chapter master password counts as advisor authority.
async function requireAdmin(req, res, next) {
  requireOfficer(req, res, (err) => {
    if (err) return next(err);
    if (!isAdmin(req)) return res.status(403).json({ error: 'President or Advisor access required' });
    next();
  });
}
// Financial writes (the balance, transactions, deposit slips, and purchase
// orders) are limited to the treasurer, president, and advisor. Plain officers
// keep read access to the treasury but can't move money.
async function requireFinance(req, res, next) {
  requireOfficer(req, res, (err) => {
    if (err) return next(err);
    const r = req.session.officerRole;
    if (r !== 'treasurer' && r !== 'president' && r !== 'advisor') {
      return res.status(403).json({ error: 'Only the treasurer, president, or advisor can change the balance or record transactions.' });
    }
    next();
  });
}

// Wrap async route handlers so errors hit the global error handler.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Officer sign-in (the only sign-in there is) ----
app.post('/api/login', ipFloodLimiter, loginLimiter, ah(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter your name or email.' });
  const password = req.body.password || '';
  // Strict mode (set by a President/Advisor) disables the shared chapter
  // password: only registered officer accounts can sign in.
  const settings = await db.getSettings();
  const strict = settings.officer_login_strict === '1';
  // Individual officer account first; the chapter master password is the
  // advisor-level break-glass credential unless strict mode is on.
  const account = await db.findOfficerByLogin(name);
  let officerName = name;
  let officerRole = null;
  let method = null;
  if (account && db.verifyOfficerPassword(account, password)) {
    officerName = account.name;
    officerRole = account.role;
    method = 'account';
  } else if (!strict && EDIT_PASSWORD && password === EDIT_PASSWORD) {
    officerRole = 'advisor';
    method = 'master password';
  } else {
    await db.logAudit(name, 'officer_login_failed', strict ? 'Wrong account credentials (strict mode)' : 'Wrong password attempt');
    return res.status(403).json({ error: strict ? 'Sign in with your officer account name and password.' : 'Wrong name or password' });
  }
  req.session.name = officerName;
  req.session.role = 'officer';
  req.session.officerRole = officerRole;
  req.session.officerId = account && method === 'account' ? account.id : null;
  req.session.officerTitle = account && method === 'account' ? (account.title || null) : null;
  req.session.officerAuth = method === 'account' ? 'account' : 'master';
  req.session.canEdit = true;
  req.session.signed_in_at = Date.now();
  await db.logAudit(officerName, 'officer_login', `Officer signed in (${method}, role=${officerRole})`);
  res.json({ name: officerName, role: 'officer', canEdit: true, officerRole, officerId: req.session.officerId || null });
}));
app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// --- Self-serve officer password reset (emailed code) ---
// Flow: request -> a 6-digit code is emailed -> verify (wrong code = clear
// error) -> complete sets the new password. Codes are stored hashed with a
// 15-minute expiry and attempt cap; the president/advisor reset in Settings
// still works independently of this.
app.post('/api/password-reset/request', ipFloodLimiter, loginLimiter, ah(async (req, res) => {
  try {
    const input = String(req.body.email || req.body.name || '').trim();
    if (!input) return res.status(400).json({ error: 'Enter your name or email first.' });
    if (!db.passwordResetEmailEnabled(await db.getSettings())) {
      return res.status(503).json({ error: 'Emailed reset codes are turned off right now. Ask the president or advisor to reset your password.' });
    }
    if (!mailer.isConfigured()) return res.status(503).json({ error: 'Email is not set up yet, so codes cannot be sent. Ask the president or advisor to reset your password.' });
    const r = await db.requestPasswordReset(input);
    await mailer.sendTemplate(r.email, 'reset_code', { name: r.name, code: r.code, expires_min: r.expires_min });
    await db.logAudit(r.name, 'password_reset_requested', 'officer requested a reset code');
    // Show a masked address so the officer knows where to look without leaking it.
    const masked = r.email.replace(/^(.).*(.)(@.*)$/, '$1***$2$3');
    res.json({ ok: true, sent_to: masked });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/password-reset/verify', ipFloodLimiter, loginLimiter, ah(async (req, res) => {
  try {
    await db.checkPasswordResetCode(String(req.body.email || '').trim(), req.body.code);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/password-reset/complete', ipFloodLimiter, loginLimiter, ah(async (req, res) => {
  try {
    const r = await db.completePasswordReset(String(req.body.email || '').trim(), req.body.code, req.body.password);
    res.json({ ok: true, name: r.name });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

// ---- Public, read-only (no sign-in) ----
// What the officer sign-in needs to know: only whether emailed reset codes are on.
app.get('/api/public/signin-config', ah(async (req, res) => {
  res.json({ password_reset_email: db.passwordResetEmailEnabled(await db.getSettings()) });
}));
// The About page's officer list: names and titles only, never emails.
app.get('/api/public/about', ah(async (req, res) => {
  const team = await db.leadershipTeam();
  const config = await db.getSettings();
  res.json({
    chapter_name: config.chapter_name || 'State High FBLA',
    tagline: config.chapter_tagline || null,
    leadership: team.map(o => ({ id: o.id, name: o.name, role: o.role, display_title: o.display_title })),
  });
}));
// Everything the public hub shows, in one response.
app.get('/api/public/hub', ah(async (req, res) => {
  if (!publicCache || Date.now() - publicCache.at > PUBLIC_CACHE_MS) {
    publicCache = { at: Date.now(), data: await db.publicHub() };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicCache.data);
}));

app.get('/api/me', ah(async (req, res) => {
  if (!req.session || !req.session.name) return res.json({ loggedIn: false });
  if (!(await refreshOfficerSession(req))) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    name: req.session.name,
    role: 'officer',
    canEdit: !!req.session.canEdit,
    officerRole: req.session.officerRole || null,
    officerId: req.session.officerId || null,
  });
}));

// ---- Treasury ----
app.get('/api/balance', requireOfficer, ah(async (req, res) => res.json(await db.getBalance())));

app.get('/api/transactions', requireOfficer, ah(async (req, res) => res.json(await db.listTransactions())));
app.post('/api/transactions', requireFinance, ah(async (req, res) => {
  const t = await db.addTransaction({ ...req.body, recorded_by: req.session.name });
  await db.logAudit(req.session.name, 'tx_add', `${t.type} $${t.amount} for ${t.description}`);
  res.json(t);
}));
app.put('/api/transactions/:id', requireFinance, ah(async (req, res) => {
  const t = await db.updateTransaction(req.params.id, req.body);
  await db.logAudit(req.session.name, 'tx_update', `id=${req.params.id}`);
  res.json(t);
}));
app.delete('/api/transactions/:id', requireFinance, ah(async (req, res) => {
  await db.deleteTransaction(req.params.id);
  await db.logAudit(req.session.name, 'tx_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ---- Events ----
app.get('/api/events', requireOfficer, ah(async (req, res) => res.json(await db.listEvents())));
app.get('/api/events/:id', requireOfficer, ah(async (req, res) => {
  const e = await db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  res.json(e);
}));
app.post('/api/events', requireOfficer, ah(async (req, res) => {
  try {
    const e = await db.addEvent(req.body);
    await db.logAudit(req.session.name, 'event_add', `${e.name} (id=${e.id})`);
    res.json(e);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));
app.put('/api/events/:id', requireOfficer, ah(async (req, res) => {
  try {
    const e = await db.updateEvent(req.params.id, req.body);
    await db.logAudit(req.session.name, 'event_update', `${e.name} (id=${e.id})`);
    res.json(e);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));
app.delete('/api/events/:id', requireOfficer, ah(async (req, res) => {
  await db.deleteEvent(req.params.id);
  await db.logAudit(req.session.name, 'event_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ---- Settings ----
app.get('/api/settings', requireOfficer, ah(async (req, res) => res.json(await db.getSettings())));
app.put('/api/settings/starting-balance', requireFinance, ah(async (req, res) => {
  const str = String(req.body.amount == null ? '' : req.body.amount).trim();
  const amount = Number(str);
  if (str === '' || !Number.isFinite(amount)) {
    return res.status(400).json({ error: 'Enter a valid dollar amount for the starting balance.' });
  }
  await db.setSetting('starting_balance', String(amount));
  await db.logAudit(req.session.name, 'set_starting_balance', `$${amount}`);
  res.json({ ok: true });
}));

// --- Customization (any officer) ---
function cleanStringList(arr, max = 40, maxLen = 60) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = String(v == null ? '' : v).trim().slice(0, maxLen);
    const key = s.toLowerCase();
    if (s && !seen.has(key)) { seen.add(key); out.push(s); }
    if (out.length >= max) break;
  }
  return out;
}
function cleanEventTypes(arr, max = 20) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const label = String((t && t.label) || '').trim().slice(0, 40);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const color = /^#[0-9a-fA-F]{6}$/.test((t && t.color) || '') ? t.color : '#1462d9';
    out.push({ key: key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `type-${out.length + 1}`, label, color });
    if (out.length >= max) break;
  }
  return out;
}
app.put('/api/settings/customization', requireOfficer, ah(async (req, res) => {
  const b = req.body || {};
  const changed = [];
  // The big blue card on the public home page.
  if (b.home_card_title !== undefined) { await db.setSetting('home_card_title', String(b.home_card_title).trim().slice(0, 90)); changed.push('home card title'); }
  if (b.home_card_desc !== undefined) { await db.setSetting('home_card_desc', String(b.home_card_desc).trim().slice(0, 400)); changed.push('home card text'); }
  if (b.home_card_button !== undefined) { await db.setSetting('home_card_button', String(b.home_card_button).trim().slice(0, 40)); changed.push('home card button'); }
  if (b.home_card_link !== undefined) {
    const link = String(b.home_card_link).trim().slice(0, 300);
    // Only store http(s) links; anything else (javascript:, etc.) is dropped.
    await db.setSetting('home_card_link', /^https?:\/\//i.test(link) ? link : '');
    changed.push('home card link');
  }
  if (b.chapter_name !== undefined) {
    await db.setSetting('chapter_name', String(b.chapter_name).trim().slice(0, 80));
    changed.push('name');
  }
  if (b.chapter_tagline !== undefined) {
    await db.setSetting('chapter_tagline', String(b.chapter_tagline).trim().slice(0, 120));
    changed.push('tagline');
  }
  if (b.transaction_categories !== undefined) {
    await db.setSetting('transaction_categories', JSON.stringify(cleanStringList(b.transaction_categories)));
    changed.push('transaction categories');
  }
  if (b.calendar_event_types !== undefined) {
    await db.setSetting('calendar_event_types', JSON.stringify(cleanEventTypes(b.calendar_event_types)));
    changed.push('calendar types');
  }
  if (b.competitive_events !== undefined) {
    const list = cleanStringList(b.competitive_events, 200, 80);
    // An emptied box means "use the standard list" rather than "no events".
    await db.setSetting('competitive_events', list.length ? JSON.stringify(list) : '');
    changed.push('competitive events');
  }
  if (b.reminder_lead_days !== undefined) {
    const n = Math.min(60, Math.max(0, Math.round(Number(b.reminder_lead_days) || 0)));
    await db.setSetting('reminder_lead_days', String(n));
    changed.push('reminder lead time');
  }
  await db.logAudit(req.session.name, 'customization_update', changed.join(', ') || 'no changes');
  res.json({ ok: true });
}));

// Display config for the officer console (the public hub gets its own copy
// inside /api/public/hub).
app.get('/api/config', requireOfficer, ah(async (req, res) => {
  const s = await db.getSettings();
  res.json({
    ...db.publicConfig(s),
    chapter_tagline: s.chapter_tagline || 'Chapter Hub',
    transaction_categories: s.transaction_categories || '[]',
    reminder_lead_days: s.reminder_lead_days || '7',
    // Suggestions for the competitive-event tag on study resources.
    competitive_events: db.competitiveEvents(s),
  });
}));

// --- System health (President/Advisor only) ---
app.get('/api/system-health', requireAdmin, ah(async (req, res) => {
  let backup = null;
  try { backup = await sheetsBackup.getStatus(); } catch (e) { backup = null; }
  res.json({ stats: await db.systemStats(), backup, recent_errors: recentErrors });
}));

app.get('/api/audit', requireOfficer, ah(async (req, res) => res.json(await db.recentAudit(300))));

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCSV(headers, rows) {
  return headers.map(csvEscape).join(',') + '\n' +
    rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
}
app.get('/api/export/transactions.csv', requireOfficer, ah(async (req, res) => {
  const rows = await db.listTransactions();
  const csv = toCSV(
    ['Date', 'Description', 'Type', 'Category', 'Amount', 'Event', 'Payment Method', 'Reference', 'Recorded By'],
    rows.map(t => [t.date, t.description, t.type, t.category || '', t.amount, t.event_name || '', t.payment_method || '', t.reference || '', t.recorded_by || ''])
  );
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send(csv);
}));

app.get('/api/deposit-slips', requireFinance, ah(async (req, res) => res.json(await db.listDepositSlips())));
app.post('/api/deposit-slips', requireFinance, ah(async (req, res) => {
  try {
    const slip = await db.createDepositSlip(req.body, req.session.name);
    await db.logAudit(req.session.name, 'deposit_slip_create', `slip #${slip.id} total $${slip.total}`);
    res.json(slip);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.get('/api/deposit-slips/:id', requireFinance, ah(async (req, res) => {
  const s = await db.getDepositSlip(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
}));
app.delete('/api/deposit-slips/:id', requireFinance, ah(async (req, res) => {
  await db.deleteDepositSlip(req.params.id);
  await db.logAudit(req.session.name, 'deposit_slip_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));
app.patch('/api/deposit-slips/:id/submitted', requireFinance, ah(async (req, res) => {
  const s = await db.markDepositSubmitted(req.params.id, !!req.body.submitted, req.body.submitted_date);
  await db.logAudit(req.session.name, 'deposit_slip_submitted', `id=${req.params.id} submitted=${!!req.body.submitted}`);
  res.json(s);
}));

app.get('/api/purchase-orders', requireFinance, ah(async (req, res) => res.json(await db.listPurchaseOrders())));
app.post('/api/purchase-orders', requireFinance, ah(async (req, res) => {
  try {
    const po = await db.createPurchaseOrder(req.body, req.session.name);
    await db.logAudit(req.session.name, 'po_create', `${po.po_number} total $${po.total}`);
    res.json(po);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.get('/api/purchase-orders/:id', requireFinance, ah(async (req, res) => {
  const p = await db.getPurchaseOrder(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
}));
app.delete('/api/purchase-orders/:id', requireFinance, ah(async (req, res) => {
  await db.deletePurchaseOrder(req.params.id);
  await db.logAudit(req.session.name, 'po_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));
app.patch('/api/purchase-orders/:id/submitted', requireFinance, ah(async (req, res) => {
  const p = await db.markPOSubmitted(req.params.id, !!req.body.submitted, req.body.submitted_date);
  await db.logAudit(req.session.name, 'po_submitted', `id=${req.params.id} submitted=${!!req.body.submitted}`);
  res.json(p);
}));

app.get('/api/backup', requireOfficer, ah(async (req, res) => {
  try {
    const dump = await db.backupJson();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await db.logAudit(req.session.name, 'backup_download', 'JSON backup downloaded');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="fbla-hub-backup-${ts}.json"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Backup failed' });
  }
}));

app.get('/api/google-sheets-backup/status', requireAdmin, ah(async (req, res) => {
  res.json(sheetsBackup.getStatus());
}));
app.post('/api/google-sheets-backup/sync', requireAdmin, ah(async (req, res) => {
  const status = await sheetsBackup.requestSync(`manual sync by ${req.session.name}`);
  if (status.state === 'not_configured') return res.status(503).json({ ...status, error: status.lastError });
  if (status.state === 'error') return res.status(502).json({ ...status, error: status.lastError });
  res.json(status);
}));

// ---- Meeting Resources + Study & Prep (the `slideshows` collection) ----
app.get('/api/slideshows', requireOfficer, ah(async (req, res) => res.json(await db.listSlideshows(true))));
app.post('/api/slideshows', requireOfficer, ah(async (req, res) => {
  try {
    const s = await db.addSlideshow(req.body, req.session.name);
    await db.logAudit(req.session.name, 'slideshow_add', `${s.kind} ${s.title}`);
    res.json(s);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/slideshows/:id', requireOfficer, ah(async (req, res) => {
  await db.deleteSlideshow(req.params.id);
  await db.logAudit(req.session.name, 'slideshow_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));
app.patch('/api/slideshows/:id/archived', requireOfficer, ah(async (req, res) => {
  const s = await db.setSlideshowArchived(req.params.id, !!req.body.archived);
  await db.logAudit(req.session.name, 'slideshow_archive', `id=${req.params.id} archived=${!!req.body.archived}`);
  res.json(s);
}));
app.patch('/api/slideshows/:id/reviewed', requireOfficer, ah(async (req, res) => {
  const s = await db.markSlideshowReviewed(req.params.id);
  await db.logAudit(req.session.name, 'slideshow_reviewed', `id=${req.params.id}`);
  res.json(s);
}));

// Resource cover images. The browser shrinks an upload to a small JPEG first,
// which keeps the request well under the 1 MB JSON limit.
function sendCover(res, cover) {
  res.setHeader('Content-Type', cover.mime);
  // The URL carries ?v=<updated_at>, so a changed cover gets a new URL.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(cover.buffer);
}
app.put('/api/slideshows/:id/cover', requireOfficer, ah(async (req, res) => {
  try {
    const r = await db.setResourceCover(req.params.id, req.body.image);
    await db.logAudit(req.session.name, 'slideshow_cover', `id=${req.params.id} cover set`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/slideshows/:id/cover', requireOfficer, ah(async (req, res) => {
  await db.removeResourceCover(req.params.id);
  await db.logAudit(req.session.name, 'slideshow_cover', `id=${req.params.id} cover removed`);
  res.json({ ok: true });
}));
app.get('/api/slideshows/:id/cover', requireOfficer, ah(async (req, res) => {
  const cover = await db.getResourceCover(req.params.id);
  if (!cover) return res.status(404).json({ error: 'No cover' });
  sendCover(res, cover);
}));
// Public: only covers of resources that are on the hub (not archived).
app.get('/api/public/resources/:id/cover', ah(async (req, res) => {
  const r = (await db.listSlideshows(false)).find(x => x.id === Number(req.params.id));
  const cover = r && r.has_cover ? await db.getResourceCover(r.id) : null;
  if (!cover) return res.status(404).json({ error: 'No cover' });
  sendCover(res, cover);
}));

// ---- Google Forms (links shown on the public Forms page) ----
app.get('/api/google-forms', requireOfficer, ah(async (req, res) => res.json(await db.listGoogleForms(true))));
app.post('/api/google-forms', requireOfficer, ah(async (req, res) => {
  try {
    const f = await db.addGoogleForm(req.body, req.session.name);
    await db.logAudit(req.session.name, 'google_form_add', f.title);
    res.json(f);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.put('/api/google-forms/:id', requireOfficer, ah(async (req, res) => {
  try {
    const f = await db.updateGoogleForm(req.params.id, req.body);
    await db.logAudit(req.session.name, 'google_form_update', `id=${req.params.id}`);
    res.json(f);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.patch('/api/google-forms/:id/open', requireOfficer, ah(async (req, res) => {
  const f = await db.setGoogleFormOpen(req.params.id, !!req.body.open);
  await db.logAudit(req.session.name, 'google_form_status', `id=${req.params.id} ${req.body.open ? 'shown' : 'hidden'}`);
  res.json(f);
}));
app.delete('/api/google-forms/:id', requireOfficer, ah(async (req, res) => {
  await db.deleteGoogleForm(req.params.id);
  await db.logAudit(req.session.name, 'google_form_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ---- Officer accounts (President/Advisor only) ----
app.get('/api/officers', requireAdmin, ah(async (req, res) => res.json(await db.listOfficers())));
app.post('/api/officers', requireAdmin, ah(async (req, res) => {
  try {
    const o = await db.addOfficer(req.body, req.session.name);
    await db.logAudit(req.session.name, 'officer_add', `${o.name} (${o.role})`);
    // Tell the new officer their account exists (background; no password sent).
    if (o.email) {
      mailer.sendTemplate(o.email, 'officer_account', {
        name: o.name, role_label: db.officerRoleLabel(o.role) || o.role, created_by: req.session.name,
      }).catch(e => console.error('[mail] officer account email failed:', e.message));
    }
    res.json(o);
  } catch (e) {
    if (e && (e.code === 11000 || /duplicate key|E11000/i.test(e.message || ''))) {
      return res.status(409).json({ error: 'An officer with that name or email already exists.' });
    }
    res.status(400).json({ error: e.message });
  }
}));
app.put('/api/officers/:id', requireAdmin, ah(async (req, res) => {
  try {
    const o = await db.updateOfficer(req.params.id, req.body);
    await db.logAudit(req.session.name, 'officer_update', `id=${req.params.id}${req.body.password ? ' (password reset)' : ''}`);
    res.json(o);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/officers/:id', requireAdmin, ah(async (req, res) => {
  try {
    await db.deleteOfficer(req.params.id);
    await db.logAudit(req.session.name, 'officer_delete', `id=${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.put('/api/settings/officer-login-strict', requireAdmin, ah(async (req, res) => {
  const enable = !!req.body.enabled;
  // Don't let anyone lock the whole team out: strict mode disables the master
  // password, so it needs at least one active President/Advisor to sign in with.
  if (enable && (await db.adminCount()) < 1) {
    return res.status(400).json({ error: 'Add at least one active President or Advisor account before turning this on, or admins will be locked out.' });
  }
  await db.setSetting('officer_login_strict', enable ? '1' : '0');
  await db.logAudit(req.session.name, 'officer_login_strict', enable ? 'enabled' : 'disabled');
  res.json({ ok: true, enabled: enable });
}));

// An officer changes their own password from Settings.
app.post('/api/officer/password', requireOfficer, pwChangeLimiter, ah(async (req, res) => {
  try {
    // A shared-chapter-password session isn't an account, so there is nothing
    // to change: it authenticates against the EDIT_PASSWORD env var.
    if (req.session.officerAuth !== 'account' || !req.session.officerId) {
      return res.status(400).json({ error: 'You are signed in with the shared chapter password, which has no account of its own. Sign in with your officer account to change its password.' });
    }
    const officer = await db.getOfficerForAuth(req.session.officerId);
    if (!officer) return res.status(404).json({ error: 'Officer account not found.' });
    const next = String(req.body.new_password || '');
    if (next !== String(req.body.confirm_password != null ? req.body.confirm_password : next)) {
      return res.status(400).json({ error: 'The new passwords do not match.' });
    }
    const current = String(req.body.current_password || '');
    if (!db.verifyOfficerPassword(officer, current)) {
      await db.logAudit(officer.name, 'officer_password_change_failed', 'wrong current password');
      return res.status(403).json({ error: 'That is not your current password.' });
    }
    if (current === next) return res.status(400).json({ error: 'Choose a password different from your current one.' });
    await db.setOfficerPassword(req.session.officerId, next);
    await db.logAudit(officer.name, 'officer_password_change', `officer=${req.session.officerId}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// Turn emailed reset codes back on (or off again) without a deploy.
app.patch('/api/settings/password-reset-email', requireAdmin, ah(async (req, res) => {
  const on = !!req.body.enabled;
  await db.setSetting('password_reset_email_enabled', on ? '1' : '0');
  await db.logAudit(req.session.name, 'password_reset_email', on ? 'enabled' : 'disabled');
  res.json({ ok: true, enabled: on });
}));

// ---- Announcements (public on the hub) ----
app.get('/api/announcements', requireOfficer, ah(async (req, res) => res.json(await db.listAnnouncements())));
app.post('/api/announcements', requireOfficer, ah(async (req, res) => {
  try {
    const a = await db.addAnnouncement(req.body, req.session.name);
    await db.logAudit(req.session.name, 'announcement_add', a.title);
    res.json(a);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.patch('/api/announcements/:id/pinned', requireOfficer, ah(async (req, res) => {
  const a = await db.setAnnouncementPinned(req.params.id, !!req.body.pinned);
  await db.logAudit(req.session.name, 'announcement_pin', `id=${req.params.id} pinned=${!!req.body.pinned}`);
  res.json(a);
}));
app.delete('/api/announcements/:id', requireOfficer, ah(async (req, res) => {
  await db.deleteAnnouncement(req.params.id);
  await db.logAudit(req.session.name, 'announcement_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// ---- Email (officer team only; templates in email-templates.js) ----
// Any officer can see whether email works; only a president/advisor sees the
// delivery details and controls.
app.get('/api/email/status', requireOfficer, ah(async (req, res) => {
  const full = mailer.status();
  if (isAdmin(req)) return res.json({ ...full, can_manage: true });
  res.json({ configured: full.configured, can_manage: false });
}));
app.post('/api/email/test', requireAdmin, ah(async (req, res) => {
  try {
    const to = String(req.body.to || '').trim();
    if (!to) return res.status(400).json({ error: 'Give an email address to send the test to.' });
    await mailer.sendTestEmail(to, req.session.name);
    await db.logAudit(req.session.name, 'email_test', `to=${to}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// Officer-composed email to the officer team. The server resolves the
// addresses (mailer.resolveRecipients), so no caller can email an arbitrary
// address list through this route. `preview: true` returns who would receive
// it without sending anything.
app.post('/api/email/compose', requireOfficer, ah(async (req, res) => {
  try {
    const opts = {
      mode: 'officers',
      subject: req.body.subject,
      body: req.body.body,
      greet: req.body.greet,
      preview: !!req.body.preview,
      sent_by: req.session.name,
    };
    const result = await mailer.sendCustomEmail(db, opts);
    if (!opts.preview) {
      await db.logAudit(req.session.name, 'email_sent',
        `"${String(opts.subject || '').slice(0, 60)}" to ${result.total} officer(s) sent=${result.sent} failed=${result.failed}`);
    }
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

// ---- Calendar (public on the hub) ----
app.get('/api/calendar', requireOfficer, ah(async (req, res) => res.json(await db.listCalendar())));
app.post('/api/calendar', requireOfficer, ah(async (req, res) => {
  try {
    const c = await db.addCalendarItem(req.body, req.session.name);
    await db.logAudit(req.session.name, 'calendar_add', `${c.title} on ${c.date}`);
    res.json(c);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.put('/api/calendar/:id', requireOfficer, ah(async (req, res) => {
  try {
    const c = await db.updateCalendarItem(req.params.id, req.body);
    await db.logAudit(req.session.name, 'calendar_update', `${c.title} on ${c.date}`);
    res.json(c);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/calendar/:id', requireOfficer, ah(async (req, res) => {
  await db.deleteCalendarItem(req.params.id);
  await db.logAudit(req.session.name, 'calendar_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// --- Google Calendar connection (public iCal link -> chapter calendar) ---
// Fetch the .ics feed, parse it, and import idempotently (matched by each
// event's iCal UID, so re-syncing updates instead of duplicating). The
// connected URL lives in settings so any officer can re-sync with one click.
app.put('/api/calendar/google-sync', requireOfficer, ah(async (req, res) => {
  const url = String(req.body.ical_url || '').trim();
  if (url && !/^(https?|webcal):\/\//i.test(url)) {
    return res.status(400).json({ error: 'Paste the calendar\'s public iCal link (starts with https:// or webcal://).' });
  }
  await db.setSetting('google_calendar_ical_url', url);
  if (!url) await db.setSetting('google_calendar_last_sync', '');
  await db.logAudit(req.session.name, 'google_calendar_connect', url ? 'Connected a Google Calendar feed' : 'Disconnected the Google Calendar feed');
  res.json({ ok: true, connected: !!url });
}));
app.post('/api/calendar/google-sync', requireOfficer, ah(async (req, res) => {
  try {
    const settings = await db.getSettings();
    const url = String(req.body.ical_url || settings.google_calendar_ical_url || '').trim();
    if (!url) return res.status(400).json({ error: 'Connect a Google Calendar first (paste its public iCal link).' });
    const dryRun = !!req.body.dry_run;
    const events = parseIcs(await fetchIcs(url));
    if (!events.length) return res.json({ dry_run: dryRun, parsed: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, items: [] });
    const result = await db.importCalendarItems(events, { dryRun, createdBy: 'Google Calendar sync' });
    if (!dryRun) {
      await db.setSetting('google_calendar_last_sync', JSON.stringify({
        at: new Date().toISOString(), parsed: events.length,
        added: result.added, updated: result.updated, unchanged: result.unchanged,
      }));
      await db.logAudit(req.session.name, 'google_calendar_sync', `parsed=${events.length} added=${result.added} updated=${result.updated}`);
    }
    res.json({ dry_run: dryRun, parsed: events.length, ...result, items: result.items.slice(0, 12) });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

// --- Officer-only calendar (private to the officer console) ---
app.get('/api/officer-calendar', requireOfficer, ah(async (req, res) => res.json(await db.listOfficerCalendar())));
app.post('/api/officer-calendar', requireOfficer, ah(async (req, res) => {
  try {
    const c = await db.addOfficerCalendarItem(req.body, req.session.name);
    await db.logAudit(req.session.name, 'officer_calendar_add', `${c.title} on ${c.date}`);
    res.json(c);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.put('/api/officer-calendar/:id', requireOfficer, ah(async (req, res) => {
  try {
    const c = await db.updateOfficerCalendarItem(req.params.id, req.body);
    await db.logAudit(req.session.name, 'officer_calendar_update', `${c.title} on ${c.date}`);
    res.json(c);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/officer-calendar/:id', requireOfficer, ah(async (req, res) => {
  await db.deleteOfficerCalendarItem(req.params.id);
  await db.logAudit(req.session.name, 'officer_calendar_delete', `id=${req.params.id}`);
  res.json({ ok: true });
}));

// Unknown API paths are a JSON 404, not the SPA.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  recordError(err, req);
  res.status(500).json({ error: (err && err.message) || 'Server error' });
});

// Local dev: start the listener. On Vercel, the platform invokes the exported app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nState High FBLA hub running at http://localhost:${PORT}  (officer console: /officer)\n`);
  });
}

module.exports = app;
