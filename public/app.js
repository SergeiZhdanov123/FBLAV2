// ===== Officer console (FBLAappV2) =====
// The officer side of the chapter hub. Officers are the only accounts: the
// public hub (index.html + hub.js) needs no sign-in and shows only public
// chapter information. This console is V1's officer portal with every
// student-account feature (roster, dues, points, attendance, tasks, committees,
// sign-ups, forms builder, forum, buddy groups, inbox) removed.

// ===== State & helpers =====
const state = {
  user: null,
  canEdit: false,
  events: [],
  transactions: [],
  depositSlips: [],
  purchaseOrders: [],
  balance: null,
  settings: {},
  audit: [],
  announcements: [],
  googleForms: [],
  calendar: [],
  calCursor: null,        // { y, m } month shown on the chapter calendar
  currentTab: 'dashboard',
  charts: {},
  sheetsBackup: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Escape a value for use in an href. HTML-escaping alone does NOT neutralize
// javascript:/data:/vbscript: URLs, so any user-supplied link is run through
// this: only http(s)/mailto/tel survive, everything else collapses to '#'. Also
// guards against legacy unsafe links already stored in the database.
// Embed a value as a JS string literal inside an HTML attribute (onclick etc).
// JSON.stringify on its own emits real double quotes, which close the attribute
// early and leave a broken handler that fails silently when clicked. Escaping
// them to &quot; lets the HTML parser hand the JS a proper string.
const jsArg = (v) => esc(JSON.stringify(v == null ? '' : String(v)));

const safeUrl = (u) => {
  const raw = String(u == null ? '' : u).trim();
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return esc(raw);
  return '#';
};

// ===== Chapter customization (configurable, no code needed) =====
function chapterConfig() {
  return state.config || state.settings || {};
}
function chapterName() {
  const c = chapterConfig();
  return (c.chapter_name || '').trim() || 'State High FBLA';
}
function chapterTagline() {
  const c = chapterConfig();
  return (c.chapter_tagline || '').trim() || 'Chapter Hub';
}
function reminderLeadDays() {
  const n = parseInt(chapterConfig().reminder_lead_days, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}
function calEventTypes() {
  const raw = chapterConfig().calendar_event_types;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    return Array.isArray(arr) ? arr.filter(t => t && t.key && t.label) : [];
  } catch (e) { return []; }
}
function txCategories() {
  const raw = chapterConfig().transaction_categories;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    return Array.isArray(arr) ? arr.filter(x => String(x || '').trim()) : [];
  } catch (e) { return []; }
}
// Push the configured chapter name/tagline into the static branding elements.
function applyChapterBranding() {
  const name = chapterName();
  const tagline = chapterTagline();
  document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = name; });
  document.querySelectorAll('[data-brand-tagline]').forEach(el => { el.textContent = tagline; });
  const titleBits = document.querySelectorAll('.login-wordmark, .brand-name');
  titleBits.forEach(el => { el.textContent = name; });
}

// A payment deadline is "passed" once its date is behind us.
function isOverdue(dueDate, paid) {
  return !paid && !!dueDate && dueDate < today();
}
function dueBadge(dueDate) {
  if (!dueDate) return '';
  return isOverdue(dueDate, false)
    ? `<span class="badge neutral">Was due ${esc(dueDate)}</span>`
    : `<span class="badge due-soon">Due ${esc(dueDate)}</span>`;
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const backupState = res.headers.get('x-google-sheets-backup');
  if (state.role === 'officer' && backupState) {
    if (backupState === 'synced') hideSheetsBackupWarning();
    if (backupState === 'failed') showSheetsBackupWarning('The change was saved, but the Google Sheets backup failed. Open Settings to retry it.');
    if (backupState === 'not-configured') showSheetsBackupWarning('The change was saved, but the Google Sheets backup still needs a spreadsheet. Finish setup in Settings.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function showSheetsBackupWarning(message) {
  const banner = $('#sheets-backup-banner');
  const text = $('#sheets-backup-banner-text');
  if (!banner || !text) return;
  text.textContent = message;
  banner.classList.remove('hidden');
}

function hideSheetsBackupWarning() {
  const banner = $('#sheets-backup-banner');
  if (banner) banner.classList.add('hidden');
}

// ===== Init =====
window.addEventListener('DOMContentLoaded', init);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, { once: true });
}

function updateOnlineStatus() {
  const banner = $('#offline-banner');
  if (banner) banner.classList.toggle('hidden', navigator.onLine);
}

async function init() {
  updateOnlineStatus();
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);

  try {
    const me = await api('GET', '/api/me');
    if (me.loggedIn) {
      state.user = me.name;
      state.role = 'officer';
      state.canEdit = !!me.canEdit;
      state.officerRole = me.officerRole || null;
      state.officerId = me.officerId || null;
      await enterOfficer();
    }
  } catch (e) { /* not signed in: show the sign-in card */ }
  // The sign-in overlay starts hidden so a reload while signed in never flashes
  // the card. Reveal it only now that we know there's no session.
  if (!state.user) {
    $('#login-overlay').classList.remove('hidden');
    setTimeout(() => { const n = $('#officer-name'); if (n) n.focus(); }, 30);
    // The hub's sign-in dialog links here with ?forgot=1 for a password reset.
    if (new URLSearchParams(location.search).get('forgot')) openPasswordResetFlow();
  }

  $('#officer-login-btn').onclick = () => doLogin();
  $('#officer-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#officer-password').focus(); });
  $('#officer-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  const forgot = $('#forgot-officer');
  if (forgot) forgot.onclick = (e) => { e.preventDefault(); openPasswordResetFlow(); };

  $('#logout-btn').onclick = signOut;

  // Officer sidebar tabs
  $$('#app .nav-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  // Officer sidebar group headers (collapsible sections).
  $$('#app .nav-group-btn').forEach(b => b.onclick = () => toggleNavGroup(b.dataset.group));
  // Collapse/expand the whole sidebar.
  const navToggle = $('#nav-toggle');
  if (navToggle) navToggle.onclick = () => $('#app').classList.toggle('nav-collapsed');

  $('#modal-cancel').onclick = closeModal;
  $('#modal-ok').onclick = async () => {
    if (!modalSubmit) { closeModal(); return; }
    // Guard against double-submits: a second click (or a click while the
    // request is still in flight) would otherwise create a duplicate record.
    if (modalSubmitting) return;
    modalSubmitting = true;
    const okBtn = $('#modal-ok');
    okBtn.disabled = true;
    try {
      const res = await modalSubmit();
      if (res) closeModal();
    } catch (e) {
      alert(e.message);
    } finally {
      modalSubmitting = false;
      okBtn.disabled = false;
    }
  };
  document.addEventListener('keydown', (e) => {
    const modal = $('#modal');
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      if (!modalNoDismiss) closeModal();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

async function signOut() {
  // Always end up back at the public hub even if the logout request hiccups,
  // so the button never appears to "do nothing".
  try { await api('POST', '/api/logout'); } catch (e) { /* clear locally regardless */ }
  location.href = '/';
}

function showLoginError(msg) {
  const el = $('#login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function doLogin() {
  $('#login-error').classList.add('hidden');
  const name = $('#officer-name').value.trim();
  const password = $('#officer-password').value;
  if (!name) { showLoginError('Enter your name or email.'); return; }
  if (!password) { showLoginError('Enter your password.'); return; }
  try {
    const r = await api('POST', '/api/login', { name, password });
    state.user = r.name;
    state.role = 'officer';
    state.canEdit = !!r.canEdit;
    state.officerRole = r.officerRole || null;
    state.officerId = r.officerId || null;
    await enterOfficer();
  } catch (e) {
    showLoginError(e.message);
  }
}

// ===== Self-serve password reset (emailed 6-digit code) =====
// Three chained steps in the shared modal: enter name/email -> type the code
// (wrong code shows a clear error and lets them retry) -> choose a new password.
// While emailed codes are switched off, the president or advisor resets the
// password from Settings > Officer Accounts instead.
async function openPasswordResetFlow() {
  let emailOn = false;
  try {
    const cfg = await (await fetch('/api/public/signin-config')).json();
    emailOn = !!cfg.password_reset_email;
  } catch (e) { emailOn = false; }
  const preset = $('#officer-name') ? $('#officer-name').value.trim() : '';

  if (!emailOn) {
    showModal('Reset your password', `
      <p>Emailed reset codes are switched off right now.</p>
      <p class="hint">Ask the chapter president or advisor to set a new password for you. They can do it in <strong>Settings &gt; Officer Accounts</strong>.</p>
    `, async () => true, 'Got it');
    return;
  }

  showModal('Reset your password', `
    <p class="hint">Enter the name or email on your officer account and we'll email you a 6-digit code.</p>
    <div class="form-row"><label>Name or email</label><input id="pr-id" value="${esc(preset)}" placeholder="e.g. Jordan Smith or you@email.com" /></div>
  `, async () => {
    const input = $('#pr-id').value.trim();
    if (!input) { alert('Enter your name or email first.'); return false; }
    let r;
    try { r = await api('POST', '/api/password-reset/request', { email: input }); }
    catch (e) { alert(e.message); return false; }
    setTimeout(() => passwordResetCodeStep(input, r.sent_to), 60);
    return true;
  }, 'Email me a code');
}

function passwordResetCodeStep(input, sentTo) {
  showModal('Check your email', `
    <p class="hint">We sent a 6-digit code to <strong>${esc(sentTo || 'your email')}</strong>. It works for 15 minutes.</p>
    <div class="form-row"><label>Code</label><input id="pr-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="letter-spacing:.3em;font-size:18px;text-align:center;" /></div>
    <div id="pr-code-err" class="login-error hidden" style="margin-top:10px;"></div>
  `, async () => {
    const code = $('#pr-code').value.trim();
    if (!/^\d{6}$/.test(code)) { showResetErr('Enter the 6-digit code from the email.'); return false; }
    try { await api('POST', '/api/password-reset/verify', { email: input, code }); }
    catch (e) { showResetErr(e.message); return false; }
    setTimeout(() => passwordResetNewPasswordStep(input, code), 60);
    return true;
  }, 'Verify code');
  function showResetErr(msg) {
    const el = $('#pr-code-err');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  }
}

function passwordResetNewPasswordStep(input, code) {
  showModal('Choose a new password', `
    <p class="hint">Code verified. Pick a new password (at least 6 characters).</p>
    <div class="form-row"><label>New password</label><input id="pr-pass" type="password" autocomplete="new-password" /></div>
    <div class="form-row"><label>Confirm password</label><input id="pr-pass2" type="password" autocomplete="new-password" /></div>
  `, async () => {
    const p1 = $('#pr-pass').value, p2 = $('#pr-pass2').value;
    if (p1.length < 6) { alert('Password must be at least 6 characters.'); return false; }
    if (p1 !== p2) { alert('Passwords do not match.'); return false; }
    let r;
    try { r = await api('POST', '/api/password-reset/complete', { email: input, code, password: p1 }); }
    catch (e) { alert(e.message); return false; }
    // Prefill the sign-in form so they can log straight in.
    const n = $('#officer-name'); if (n) n.value = r.name || input;
    setTimeout(() => alert('Password changed. Sign in with your new password.'), 60);
    return true;
  }, 'Change password');
}

// ===== Password strength =====
// Advisory meter with two hard rules: at least 6 characters (what the server
// enforces), and not one of the passwords everyone tries first. Everything else
// is guidance, so an officer is never locked out of their own account by a
// scoring quirk.
const COMMON_PASSWORDS = [
  'password', 'password1', 'passw0rd', '123456', '1234567', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyuiop', 'abc123', '111111', '000000', 'letmein', 'iloveyou', 'admin',
  'welcome', 'monkey', 'dragon', 'football', 'baseball', 'basketball', 'sunshine', 'princess',
  'superman', 'batman', 'trustno1', 'starwars', 'whatever', 'zaq12wsx', 'asdfghjkl',
  'fbla', 'statehigh', 'statehighfbla', 'schoolpassword',
];

// Returns { score 0-4, label, hint, ok }. `personal` is a list of things that
// should not appear in the password (their name, their email).
function passwordStrength(pw, personal = []) {
  const p = String(pw || '');
  if (!p) return { score: 0, label: '', hint: '', ok: false };
  if (p.length < 6) return { score: 0, label: 'Too short', hint: 'Use at least 6 characters.', ok: false };

  const lowered = p.toLowerCase();
  if (COMMON_PASSWORDS.some(c => lowered === c || (c.length >= 6 && lowered.includes(c)))) {
    return { score: 0, label: 'Too common', hint: 'This is one of the first passwords anyone would guess. Pick something else.', ok: false };
  }

  const lower = /[a-z]/.test(p), upper = /[A-Z]/.test(p), digit = /\d/.test(p), symbol = /[^A-Za-z0-9]/.test(p);
  const variety = [lower, upper, digit, symbol].filter(Boolean).length;

  // Personal info is guessable by anyone who knows them, so it caps the score.
  const usesPersonal = personal.some(v => {
    const t = String(v || '').toLowerCase().split('@')[0];
    return t.length >= 4 && lowered.includes(t);
  });
  // A single repeated character or a straight run reads long but isn't.
  const isRepetitive = /^(.)\1+$/.test(p) || /^(?:0123456789|abcdefghijklmnopqrstuvwxyz){1,}/.test(lowered.slice(0, p.length));

  let score = 1;
  if (p.length >= 10) score++;
  if (variety >= 3) score++;
  if (p.length >= 14 || (variety === 4 && p.length >= 12)) score++;
  if (usesPersonal || isRepetitive) score = Math.min(score, 1);
  score = Math.max(1, Math.min(4, score));

  const labels = { 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong' };
  let hint = '';
  if (usesPersonal) hint = 'Avoid your own name or email in your password.';
  else if (isRepetitive) hint = 'Repeated or sequential characters are easy to guess.';
  else if (score === 1) hint = 'Make it longer, or mix in capitals, numbers, or symbols.';
  else if (score === 2) hint = 'A few more characters would make this much harder to guess.';
  else if (score === 3) hint = 'Good. A longer passphrase would be even better.';
  else hint = 'Strong password.';

  return { score, label: labels[score], hint, ok: true };
}

// Paint the meter that sits under a password box.
function renderPasswordStrength(boxId, value, personal = []) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const s = passwordStrength(value, personal);
  if (!String(value || '')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.className = `pw-strength pw-s${s.score}`;
  const text = box.querySelector('.pw-strength-text');
  if (text) text.textContent = s.label;
  box.title = s.hint;
}

// Display names for the officer roles (matches db.officerRoleLabel).
const OFFICER_ROLE_LABELS = { president: 'President', advisor: 'Advisor', treasurer: 'Treasurer', officer: 'Officer' };

async function enterOfficer() {
  $('#login-overlay').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // On phones the nav lives at the top; start it collapsed so content shows first.
  if (window.innerWidth <= 780) $('#app').classList.add('nav-collapsed');
  $('#user-name').textContent = state.user || '';
  // Show the signed-in officer's actual role, not a generic "Officer".
  const roleEl = $('#user-role');
  if (roleEl) roleEl.textContent = OFFICER_ROLE_LABELS[state.officerRole] || 'Officer';
  const officerSignout = $('#logout-btn');
  if (officerSignout) officerSignout.onclick = signOut;
  // Deposit slips and purchase orders are finance-only (treasurer/president/
  // advisor); hide those tabs from regular officers.
  ['deposits', 'purchase-orders'].forEach(t => {
    const btn = document.querySelector(`#app .nav-btn[data-tab="${t}"]`);
    if (btn) btn.style.display = canFinance() ? '' : 'none';
  });
  await loadAll();
  render();
}

// "2h ago" style labels from the backend's "YYYY-MM-DD HH:MM:SS" UTC stamps.
function relTime(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + (String(ts).length === 19 ? 'Z' : ''));
  if (isNaN(d)) return ts;
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function switchTab(tab) {
  state.currentTab = tab;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach(t => t.classList.add('hidden'));
  $('#tab-' + tab).classList.remove('hidden');
  openParentGroup(tab);
  // On mobile the nav is a top drop-down; close it after picking a tab.
  if (window.innerWidth <= 780) $('#app').classList.add('nav-collapsed');
  if (tab === 'dashboard') drawDashboardCharts();
}

// Grouped sidebar: expand the group that holds `tab` and collapse the rest so
// the active sub-tab is always visible. A standalone tab (Dashboard) collapses
// every group.
function openParentGroup(tab) {
  const btn = document.querySelector(`#app .nav-btn[data-tab="${tab}"]`);
  const grp = btn ? btn.closest('.nav-group') : null;
  $$('#app .nav-group').forEach(g => g.classList.toggle('open', g === grp));
  updateNavGroupAlerts();
}

// Clicking a group header toggles just that section (accordion: others close).
window.toggleNavGroup = function(group) {
  const btn = document.querySelector(`#app .nav-group-btn[data-group="${group}"]`);
  if (!btn) return;
  const grp = btn.closest('.nav-group');
  const willOpen = !grp.classList.contains('open');
  $$('#app .nav-group').forEach(g => g.classList.remove('open'));
  if (willOpen) grp.classList.add('open');
  updateNavGroupAlerts();
};

// Surface a badge on the group header when it's collapsed, so a hidden section
// still signals it needs attention.
function updateNavGroupAlerts() {
  $$('#app .nav-group').forEach(g => {
    const hasBadge = !!Array.from(g.querySelectorAll('.nav-badge')).find(b => !b.classList.contains('hidden'));
    g.classList.toggle('has-alert', hasBadge && !g.classList.contains('open'));
  });
}

async function loadAll() {
  const [e, t, b, ds, po, s, a, sh, ann, cal, gf, cfg] = await Promise.all([
    api('GET', '/api/events'),
    api('GET', '/api/transactions'),
    api('GET', '/api/balance'),
    api('GET', '/api/deposit-slips').catch(() => []),
    api('GET', '/api/purchase-orders').catch(() => []),
    api('GET', '/api/settings'),
    api('GET', '/api/audit'),
    api('GET', '/api/slideshows'),
    api('GET', '/api/announcements'),
    api('GET', '/api/calendar'),
    api('GET', '/api/google-forms'),
    api('GET', '/api/config'),
  ]);
  try { state.officerCalendar = await api('GET', '/api/officer-calendar'); } catch (err) { state.officerCalendar = []; }
  state.config = cfg;
  state.events = e; state.transactions = t;
  state.balance = b; state.depositSlips = ds; state.purchaseOrders = po;
  state.settings = s; state.audit = a;
  state.slideshows = sh; state.announcements = ann;
  state.calendar = cal; state.googleForms = gf;
  try { state.email = await api('GET', '/api/email/status'); } catch (err) { state.email = null; }
  // Officer accounts are President/Advisor-only; standard officers get a 403.
  state.officers = [];
  if (state.officerRole === 'president' || state.officerRole === 'advisor') {
    try { state.officers = await api('GET', '/api/officers'); } catch (err) {}
    try { state.sheetsBackup = await api('GET', '/api/google-sheets-backup/status'); } catch (err) { state.sheetsBackup = null; }
    try { state.systemHealth = await api('GET', '/api/system-health'); } catch (err) { state.systemHealth = null; }
  }
  applyChapterBranding();
}

function render() {
  renderDashboard();
  renderTransactions();
  renderEvents();
  renderOfficerCalendar();
  renderOfficerPrivateCalendar();
  renderOfficerAnnouncements();
  renderOfficerGoogleForms();
  renderOfficerEmail();
  renderDeposits();
  renderPurchaseOrders();
  renderOfficerSlideshows();
  renderOfficerResources();
  renderOfficerGeneral();
  renderAudit();
  renderCustomization();
  renderSettings();
  if (state.currentTab === 'dashboard') drawDashboardCharts();
}


// ===== Dashboard =====
function renderDashboard() {
  const b = state.balance || { balance: 0, income: 0, expenses: 0, starting_balance: 0 };
  const recent = state.transactions.slice(0, 10);
  const net = b.income - b.expenses;
  // "Needs your attention": a prioritized queue built from current data.
  // A date is "soon" if it's today or later but within the reminder lead window.
  const leadDays = reminderLeadDays();
  const dueSoon = (dateStr) => {
    if (!dateStr) return false;
    const due = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(due.getTime())) return false;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const diff = Math.round((due - now) / 86400000);
    return diff >= 0 && diff <= leadDays;
  };
  let paymentDeadlines = 0;
  (state.events || []).forEach(e => {
    if (Number(e.cost_per_member) > 0 && dueSoon(e.first_payment_due)) paymentDeadlines++;
    if (e.second_payment_enabled && Number(e.second_payment_amount) > 0 && dueSoon(e.second_payment_due)) paymentDeadlines++;
  });
  const staleResources = (state.slideshows || []).filter(s => !s.archived && resourceStale(s)).length;
  const pastDueForms = (state.googleForms || []).filter(f => f.open && f.due_date && f.due_date < today()).length;
  const upcomingEvents = (state.events || []).filter(e => e.date && e.date >= today()).length;
  const openForms = (state.googleForms || []).filter(f => f.open).length;
  const attn = [];
  if (paymentDeadlines) attn.push({ n: paymentDeadlines, label: `event payment ${paymentDeadlines === 1 ? 'deadline' : 'deadlines'} in the next ${leadDays} day${leadDays === 1 ? '' : 's'}`, tab: 'events' });
  if (pastDueForms) attn.push({ n: pastDueForms, label: `Google ${pastDueForms === 1 ? 'Form is' : 'Forms are'} past the respond-by date but still showing on the hub`, tab: 'google-forms' });
  if (staleResources) attn.push({ n: staleResources, label: `${staleResources === 1 ? 'resource' : 'resources'} not reviewed in 6+ months`, tab: 'resources' });

  $('#tab-dashboard').innerHTML = `
    <h2>Dashboard</h2>

    <div class="panel attention-panel">
      <h3>Needs your attention</h3>
      ${attn.length
        ? `<ul class="attn-list">${attn.map(a => `<li><button class="attn-item" onclick="switchTab('${a.tab}')"><span class="attn-count">${a.n}</span> ${esc(a.label)}</button></li>`).join('')}</ul>`
        : '<div class="empty">You\'re all caught up. Nothing needs a decision right now.</div>'}
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Current Balance</div><div class="kpi-value">${fmt(b.balance)}</div><div class="kpi-sub">Starting ${fmt(b.starting_balance)}</div></div>
      <div class="kpi income"><div class="kpi-label">Total Income</div><div class="kpi-value">${fmt(b.income)}</div><div class="kpi-sub">Net ${net >= 0 ? '+' : ''}${fmt(net)}</div></div>
      <div class="kpi expense"><div class="kpi-label">Total Expenses</div><div class="kpi-value">${fmt(b.expenses)}</div><div class="kpi-sub">${state.transactions.filter(t => t.type === 'expense').length} entries</div></div>
      <div class="kpi"><div class="kpi-label">Events</div><div class="kpi-value">${state.events.length}</div><div class="kpi-sub">${upcomingEvents} upcoming</div></div>
      <div class="kpi"><div class="kpi-label">Announcements</div><div class="kpi-value">${(state.announcements || []).length}</div><div class="kpi-sub">${(state.announcements || []).filter(a => a.pinned).length} pinned</div></div>
      <div class="kpi"><div class="kpi-label">Google Forms</div><div class="kpi-value">${openForms}</div><div class="kpi-sub">showing on the hub</div></div>
    </div>

    <div class="chart-grid">
      <div class="chart-panel">
        <h3>Income vs Expenses</h3>
        <div class="chart-canvas-wrap"><canvas id="chart-io"></canvas></div>
      </div>
      <div class="chart-panel">
        <h3>Balance Over Time</h3>
        <div class="chart-canvas-wrap"><canvas id="chart-trend"></canvas></div>
      </div>
    </div>

    <div class="chart-grid">
      <div class="chart-panel">
        <h3>Income by Category</h3>
        <div class="chart-canvas-wrap"><canvas id="chart-income-cat"></canvas></div>
      </div>
      <div class="chart-panel">
        <h3>Spending by Category</h3>
        <div class="chart-canvas-wrap"><canvas id="chart-expense-cat"></canvas></div>
      </div>
    </div>

    <div class="panel">
      <h3>Recent Activity</h3>
      ${recent.length === 0 ? '<div class="empty">No transactions yet.</div>' : `
        <table>
          <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Amount</th><th>By</th></tr></thead>
          <tbody>${recent.map(t => `
            <tr>
              <td>${esc(t.date)}</td>
              <td>${esc(t.description)}</td>
              <td><span class="badge ${t.type}">${t.type}</span></td>
              <td class="${t.type === 'income' ? 'amount-pos' : 'amount-neg'}">${t.type === 'income' ? '+' : '-'}${fmt(t.amount)}</td>
              <td>${esc(t.recorded_by || '')}</td>
            </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `;
}

function destroyDashboardCharts() {
  Object.values(state.charts).forEach(c => { try { c && c.destroy(); } catch (e) {} });
  state.charts = {};
}

function drawDashboardCharts() {
  destroyDashboardCharts();
  if (state.currentTab !== 'dashboard') return;
  if (typeof Chart === 'undefined') return;

  const txs = state.transactions || [];
  const b = state.balance || { balance: 0, income: 0, expenses: 0, starting_balance: 0 };

  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';

  // Income vs Expenses donut (FBLA blue vs red)
  const io = document.getElementById('chart-io');
  if (io) {
    state.charts.io = new Chart(io, {
      type: 'doughnut',
      data: {
        labels: ['Income', 'Expenses'],
        datasets: [{
          data: [b.income, b.expenses],
          backgroundColor: ['#003f87', '#b91c1c'],
          borderWidth: 0,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: {
          legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, font: { size: 12 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: $${Number(ctx.parsed).toLocaleString('en-US', { minimumFractionDigits: 2 })}` } }
        }
      }
    });
  }

  // Balance trend line (FBLA blue)
  const tr = document.getElementById('chart-trend');
  if (tr) {
    const sorted = [...txs].sort((a, c) => a.date.localeCompare(c.date) || a.id - c.id);
    let bal = b.starting_balance;
    const labels = ['Start'];
    const data = [Math.round(bal * 100) / 100];
    sorted.forEach(t => {
      bal += t.type === 'income' ? t.amount : -t.amount;
      labels.push(t.date);
      data.push(Math.round(bal * 100) / 100);
    });
    state.charts.trend = new Chart(tr, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Balance',
          data,
          borderColor: '#003f87',
          backgroundColor: 'rgba(0, 63, 135, 0.08)',
          fill: true,
          tension: 0,
          pointRadius: 3,
          pointBackgroundColor: '#003f87',
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => 'Balance: $' + Number(ctx.parsed.y).toLocaleString('en-US', { minimumFractionDigits: 2 }) } }
        },
        scales: {
          y: { ticks: { callback: (v) => '$' + v }, grid: { color: '#f1f5f9' }, border: { display: false } },
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 }, border: { display: false } }
        }
      }
    });
  }

  // Income shades of FBLA blue; expense shades of FBLA gold/warm
  const palette = ['#003f87', '#1e5fa8', '#3b7fc3', '#5f9bd5', '#8fbae5', '#bcd6f0', '#002d63', '#001d42'];
  const expensePalette = ['#fdb913', '#e2a004', '#b07f00', '#7c5800', '#b91c1c', '#dc2626', '#7f1d1d', '#451a03'];

  const inc = document.getElementById('chart-income-cat');
  if (inc) {
    const cats = {};
    txs.filter(t => t.type === 'income').forEach(t => {
      const c = t.category || 'Uncategorized';
      cats[c] = (cats[c] || 0) + t.amount;
    });
    drawPie(inc, 'incCat', Object.keys(cats), Object.values(cats), palette);
  }

  const exp = document.getElementById('chart-expense-cat');
  if (exp) {
    const cats = {};
    txs.filter(t => t.type === 'expense').forEach(t => {
      const c = t.category || 'Uncategorized';
      cats[c] = (cats[c] || 0) + t.amount;
    });
    drawPie(exp, 'expCat', Object.keys(cats), Object.values(cats), expensePalette);
  }
}

function drawPie(canvas, key, labels, data, colors) {
  if (!labels.length) {
    canvas.parentElement.innerHTML = '<div class="empty">No data yet</div>';
    return;
  }
  state.charts[key] = new Chart(canvas, {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'white', borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: $${Number(ctx.parsed).toLocaleString('en-US', { minimumFractionDigits: 2 })}` } }
      }
    }
  });
}

// ===== Transactions =====
function renderTransactions() {
  $('#tab-transactions').innerHTML = `
    <h2>Transactions</h2>
    <div class="toolbar">
      <input id="tx-search" placeholder="Search description, category..." />
      <select id="tx-filter">
        <option value="">All types</option>
        <option value="income">Income</option>
        <option value="expense">Expense</option>
      </select>
      <button class="btn secondary" onclick="window.open('/api/export/transactions.csv')">Export CSV</button>
      ${canFinance() ? '<button class="btn" onclick="openTxForm()">+ New Transaction</button>' : ''}
    </div>
    ${canFinance() ? '' : '<p class="hint">Only the treasurer, president, or advisor can add or change transactions. You can view everything here.</p>'}
    <table>
      <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Event</th><th>Method</th><th>Amount</th><th>By</th><th></th></tr></thead>
      <tbody id="tx-tbody"></tbody>
    </table>
  `;
  const renderRows = () => {
    const q = $('#tx-search').value.toLowerCase();
    const f = $('#tx-filter').value;
    const rows = state.transactions.filter(t =>
      (!f || t.type === f) &&
      (!q || (t.description || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q))
    );
    $('#tx-tbody').innerHTML = rows.length === 0
      ? `<tr><td colspan="8" class="empty">No transactions found.</td></tr>`
      : rows.map(t => `
        <tr>
          <td>${esc(t.date)}</td>
          <td>${esc(t.description)}</td>
          <td>${esc(t.category || '')}</td>
          <td>${esc(t.event_name || '')}</td>
          <td>${esc(t.payment_method || '')}</td>
          <td class="${t.type === 'income' ? 'amount-pos' : 'amount-neg'}">${t.type === 'income' ? '+' : '-'}${fmt(t.amount)}</td>
          <td>${esc(t.recorded_by || '')}</td>
          <td>${canFinance() ? `<button class="btn small danger" onclick="deleteTx(${t.id})">Delete</button>` : ''}</td>
        </tr>`).join('');
  };
  $('#tx-search').oninput = renderRows;
  $('#tx-filter').onchange = renderRows;
  renderRows();
}

async function deleteTx(id) {
  if (!confirm('Delete this transaction? The balance will be recalculated.')) return;
  await api('DELETE', '/api/transactions/' + id);
  await loadAll(); render();
}

function openTxForm() {
  showModal('New Transaction', `
    <div class="form-row"><label>Date</label><input id="f-date" type="date" value="${today()}" /></div>
    <div class="form-row"><label>Type</label>
      <select id="f-type">
        <option value="income">Income (money in)</option>
        <option value="expense">Expense (money out)</option>
      </select>
    </div>
    <div class="form-row"><label>Amount ($)</label><input id="f-amount" type="number" step="0.01" min="0" /></div>
    <div class="form-row"><label>Description</label><input id="f-desc" placeholder="What is this transaction for?" /></div>
    <div class="form-row"><label>Category</label>
      <input id="f-cat" list="f-cat-list" placeholder="e.g. Fundraiser, Supplies" />
      ${txCategories().length ? `<datalist id="f-cat-list">${txCategories().map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>` : ''}
    </div>
    <div class="form-row"><label>Payment Method</label>
      <select id="f-pm">
        <option value="">--</option>
        <option>Cash</option><option>Check</option><option>Card</option>
        <option>Venmo</option><option>Deposit</option><option>Other</option>
      </select>
    </div>
    <div class="form-row"><label>Reference</label><input id="f-ref" placeholder="Check #, invoice #, etc." /></div>
    <div class="form-row"><label>Event (optional)</label>
      <select id="f-event"><option value="">--</option>${state.events.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
    </div>
  `, async () => {
    const body = {
      date: $('#f-date').value,
      type: $('#f-type').value,
      amount: $('#f-amount').value,
      description: $('#f-desc').value.trim(),
      category: $('#f-cat').value,
      payment_method: $('#f-pm').value,
      reference: $('#f-ref').value,
      event_id: $('#f-event').value ? Number($('#f-event').value) : null,
    };
    if (!body.amount || Number(body.amount) <= 0) { alert('Amount required'); return false; }
    if (!body.description) { alert('Description required'); return false; }
    await api('POST', '/api/transactions', body);
    await loadAll(); render();
    return true;
  });
}

// ===== Events =====
// Events are public chapter information (conferences, competitions, trips):
// they appear on the hub calendar with their payment deadlines, and can put a
// countdown banner on the hub. There is no attendee roster.
function eventWhen(e) {
  const bits = [];
  if (e.date) bits.push(esc(e.date));
  if (e.time) bits.push(esc(fmtTime(e.time)));
  if (e.location) bits.push(esc(e.location));
  return bits.join(', ');
}
// "14:30" -> "2:30 PM".
function fmtTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return hhmm || '';
  let h = Number(m[1]); const min = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

function renderEvents() {
  $('#tab-events').innerHTML = `
    <h2>Events</h2>
    <p class="hint">Events show on the public hub calendar, along with their payment due dates. Turn on a countdown to put a live timer at the top of the hub. Record payments people make in Transactions, linked to the event.</p>
    <div class="toolbar">
      <button class="btn" onclick="openEventForm()" ${state.canEdit ? '' : 'disabled'}>+ Add Event</button>
    </div>
    <div id="events-list"></div>
  `;
  const list = $('#events-list');
  if (state.events.length === 0) {
    list.innerHTML = `<div class="panel empty">No events yet. Add a conference or competition so it shows on the chapter calendar.</div>`;
    return;
  }
  list.innerHTML = state.events.map(e => {
    // Only treat a payment as collectible when it's actually more than $0.
    const hasFirst = Number(e.cost_per_member) > 0;
    const hasSecond = !!e.second_payment_enabled && Number(e.second_payment_amount) > 0;
    const collected = (state.transactions || [])
      .filter(t => t.event_id === e.id && t.type === 'income')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    return `
    <div class="event-card">
      <div class="event-header">
        <div style="flex:1;min-width:260px;">
          <h3>${esc(e.name)}${eventWhen(e) ? `<span style="color:var(--muted);font-weight:400;font-size:14px">, ${eventWhen(e)}</span>` : ''}</h3>
          <div class="event-meta">
            ${hasFirst
              ? `First payment: <strong>${fmt(e.cost_per_member)}</strong>${e.first_payment_due ? ` ${dueBadge(e.first_payment_due)}` : ''}`
              : `<span class="badge neutral">No payment required</span>`}
            ${hasSecond ? ` &nbsp;|&nbsp; Second payment: <strong>${fmt(e.second_payment_amount)}</strong>${e.second_payment_due ? ` ${dueBadge(e.second_payment_due)}` : ''}` : ''}
          </div>
          <div class="event-meta">
            ${e.countdown_enabled ? `<span class="badge paid">Countdown on</span>${e.countdown_start ? ` <span class="muted" style="font-size:12px;">from ${esc(e.countdown_start)}</span>` : ''}` : '<span class="muted" style="font-size:12px;">No countdown</span>'}
            ${collected ? ` &nbsp;|&nbsp; ${fmt(collected)} recorded in Transactions` : ''}
          </div>
          ${e.description ? `<p style="margin:10px 0 0;">${esc(e.description)}</p>` : ''}
        </div>
        <div>
          ${state.canEdit ? `
            <button class="btn small secondary" onclick="openEventForm(${e.id})">Edit</button>
            <button class="btn small danger" onclick="deleteEvent(${e.id})">Delete</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function openEventForm(id) {
  const e = id ? state.events.find(x => x.id === id) : {};
  const enabled = !!e.second_payment_enabled;
  showModal(id ? 'Edit Event' : 'Add Event', `
    <div class="form-row"><label>Name</label><input id="f-ename" value="${esc(e.name || '')}" /></div>
    <div class="form-row"><label>Date</label><input id="f-edate" type="date" value="${esc(e.date || '')}" /></div>
    <div class="form-row"><label>Start Time (optional)</label><input id="f-etime" type="time" value="${esc(e.time || '')}" /></div>
    <div class="form-row"><label>Location (optional)</label><input id="f-elocation" maxlength="120" placeholder="e.g. Hershey Lodge" value="${esc(e.location || '')}" /></div>
    <div class="form-row"><label>First Payment ($)</label><input id="f-ecost" type="number" step="0.01" min="0" value="${e.cost_per_member || 0}" /></div>
    <div class="form-row"><label>First Payment Due Date</label><input id="f-edue1" type="date" value="${esc(e.first_payment_due || '')}" /><span class="hint" style="margin-top:4px;">Optional. Shows on the calendar as a deadline.</span></div>
    <div class="form-row"><label>Second Payment</label>
      <label style="display:flex;align-items:center;gap:8px;">
        <input id="f-eenabled" type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleSecondPay()" style="width:auto;" />
        <span>Enable a second payment</span>
      </label>
    </div>
    <div id="second-pay-fields" style="${enabled ? '' : 'display:none;'}">
      <div class="form-row"><label>Second Payment ($)</label><input id="f-esecond" type="number" step="0.01" min="0" value="${e.second_payment_amount || 0}" /></div>
      <div class="form-row"><label>Second Payment Due Date</label><input id="f-edue2" type="date" value="${esc(e.second_payment_due || '')}" /></div>
    </div>
    <div class="form-row"><label>Countdown Banner</label>
      <label style="display:flex;align-items:center;gap:8px;">
        <input id="f-ecountdown" type="checkbox" ${e.countdown_enabled ? 'checked' : ''} onchange="toggleCountdown()" style="width:auto;" />
        <span>Show a countdown to this event at the top of the hub</span>
      </label>
    </div>
    <div id="countdown-fields" style="${e.countdown_enabled ? '' : 'display:none;'}">
      <div class="form-row"><label>Count down to</label>
        <input id="f-ecdtime" type="time" value="${esc(e.countdown_time || '')}" />
        <span class="hint" style="margin-top:4px;">The time on the event date the countdown ticks down to. Leave blank to use the start time.</span>
      </div>
      <div class="form-row"><label>Start the countdown on</label>
        <input id="f-ecdstart" type="date" value="${esc(e.countdown_start || '')}" />
        <span class="hint" style="margin-top:4px;">Leave blank to start right away. The banner leaves the hub once the event date passes.</span>
      </div>
    </div>
    <div class="form-row"><label>Description</label><textarea id="f-edesc" rows="2">${esc(e.description || '')}</textarea></div>
  `, async () => {
    const body = {
      name: $('#f-ename').value.trim(),
      date: $('#f-edate').value,
      time: $('#f-etime').value || null,
      location: $('#f-elocation').value.trim(),
      cost_per_member: $('#f-ecost').value,
      second_payment_enabled: $('#f-eenabled').checked ? 1 : 0,
      second_payment_amount: $('#f-esecond') ? $('#f-esecond').value : 0,
      first_payment_due: $('#f-edue1').value || null,
      second_payment_due: $('#f-edue2') ? ($('#f-edue2').value || null) : null,
      countdown_enabled: $('#f-ecountdown').checked ? 1 : 0,
      countdown_time: ($('#f-ecountdown').checked && $('#f-ecdtime').value) ? $('#f-ecdtime').value : null,
      countdown_start: ($('#f-ecountdown').checked && $('#f-ecdstart').value) ? $('#f-ecdstart').value : null,
      description: $('#f-edesc').value
    };
    if (!body.name) { alert('Name required'); return false; }
    if (body.countdown_enabled && !body.date) { alert('A countdown needs an event date.'); return false; }
    if (id) await api('PUT', '/api/events/' + id, body);
    else await api('POST', '/api/events', body);
    await loadAll(); render();
    return true;
  });
}

window.toggleSecondPay = function() {
  const en = $('#f-eenabled').checked;
  $('#second-pay-fields').style.display = en ? '' : 'none';
};

window.toggleCountdown = function() {
  const row = $('#countdown-fields');
  if (row) row.style.display = $('#f-ecountdown').checked ? '' : 'none';
};

async function deleteEvent(id) {
  if (!confirm('Delete this event? It leaves the calendar. Linked transactions, forms, and resources stay, just unlinked.')) return;
  await api('DELETE', '/api/events/' + id);
  await loadAll(); render();
}

// ===== Deposit Slips =====
function renderDeposits() {
  $('#tab-deposits').innerHTML = `
    <h2>Deposit Slips</h2>
    <p style="color:var(--muted);margin:0 0 16px;">Bundle income transactions into a deposit slip for the school bookkeeper. Transactions are not duplicated. Mark as submitted once turned in.</p>
    <div class="toolbar">
      <button class="btn" onclick="openDepositForm()" ${state.canEdit ? '' : 'disabled'}>+ New Deposit Slip</button>
    </div>
    <table>
      <thead><tr><th>#</th><th>Date</th><th>Treasurer</th><th>Purpose</th><th>Txns</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${state.depositSlips.length === 0 ? `<tr><td colspan="8" class="empty">No deposit slips yet.</td></tr>` : state.depositSlips.map(s => `
          <tr>
            <td>#${s.id}</td>
            <td>${esc(s.date)}</td>
            <td>${esc(s.deposited_by || '')}</td>
            <td>${esc(s.purpose || '')}</td>
            <td>${s.tx_count || 0}</td>
            <td><strong>${fmt(s.total)}</strong></td>
            <td>${s.submitted
              ? `<span class="badge paid">Submitted</span><div style="font-size:11px;color:var(--muted);">${esc(s.submitted_date || '')}</div>`
              : `<span class="badge unpaid">Pending</span>`}
            </td>
            <td>
              <button class="btn small secondary" onclick="printDeposit(${s.id})">Print / PDF</button>
              ${state.canEdit ? (s.submitted
                ? `<button class="btn small secondary" onclick="toggleDepositSubmitted(${s.id}, false)">Unmark</button>`
                : `<button class="btn small gold" onclick="toggleDepositSubmitted(${s.id}, true)">Mark Submitted</button>`) : ''}
              ${state.canEdit ? `<button class="btn small danger" onclick="deleteDeposit(${s.id})">Delete</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function openDepositForm() {
  const available = state.transactions.filter(t => t.type === 'income' && !t.deposit_slip_id);
  if (available.length === 0) {
    showModal('New Deposit Slip', `
      <p>There are no income transactions available to deposit. Record income transactions (chapter dues, event payments, fundraiser revenue, etc.) first, then create a deposit slip to bundle them.</p>
    `, async () => true, 'Close');
    return;
  }
  showModal('New Deposit Slip', `
    <div class="form-row"><label>Date Prepared</label><input id="d-date" type="date" value="${today()}" /></div>
    <div class="form-row"><label>Activity Account #</label><input id="d-acct" placeholder="FBLA activity fund #" /></div>
    <div class="form-row"><label>Purpose / Source</label><input id="d-purpose" placeholder="e.g. Chapter dues, regionals fees, bake sale" /></div>
    <div class="form-row"><label>Treasurer</label><input id="d-by" value="${esc(state.user || '')}" /></div>
    <div class="form-row"><label>Advisor</label><input id="d-advisor" placeholder="Advisor full name" /></div>
    <div class="form-row"><label>Notes</label><textarea id="d-notes" rows="2"></textarea></div>
    <h3 style="margin-top:18px;font-size:14px;color:var(--fbla-blue);">Select income transactions to include</h3>
    <div style="display:flex;gap:8px;margin:8px 0;">
      <button class="btn small secondary" type="button" onclick="depositSelectAll(true)">Select All</button>
      <button class="btn small secondary" type="button" onclick="depositSelectAll(false)">Clear</button>
    </div>
    <div style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;">
      <table style="border:none;">
        <thead><tr><th style="width:32px;"></th><th>Date</th><th>Description</th><th>Method</th><th>Reference</th><th style="text-align:right;">Amount</th></tr></thead>
        <tbody>${available.map(t => `
          <tr>
            <td><input type="checkbox" class="d-tx" data-id="${t.id}" data-amt="${t.amount}" onchange="recalcDeposit()" /></td>
            <td>${esc(t.date)}</td>
            <td>${esc(t.description)}</td>
            <td>${esc(t.payment_method || '')}</td>
            <td>${esc(t.reference || '')}</td>
            <td style="text-align:right;"><strong>${fmt(t.amount)}</strong></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p style="text-align:right;margin-top:14px;font-size:16px;font-weight:700;color:var(--text);">
      Selected Total: <span id="d-total">$0.00</span>
    </p>
  `, async () => {
    const ids = [];
    $$('.d-tx:checked').forEach(c => ids.push(Number(c.dataset.id)));
    if (ids.length === 0) { alert('Select at least one transaction.'); return false; }
    await api('POST', '/api/deposit-slips', {
      date: $('#d-date').value,
      deposited_by: $('#d-by').value,
      advisor: $('#d-advisor').value,
      account: $('#d-acct').value,
      purpose: $('#d-purpose').value,
      notes: $('#d-notes').value,
      transaction_ids: ids
    });
    await loadAll(); render();
    return true;
  }, 'Create Slip');
}

window.depositSelectAll = function(state) {
  $$('.d-tx').forEach(c => { c.checked = state; });
  recalcDeposit();
};

window.recalcDeposit = function() {
  let total = 0;
  $$('.d-tx:checked').forEach(c => total += Number(c.dataset.amt) || 0);
  const el = $('#d-total');
  if (el) el.textContent = fmt(total);
};

async function toggleDepositSubmitted(id, submitted) {
  let date = today();
  if (submitted) {
    const input = prompt('Date submitted to school bookkeeper (YYYY-MM-DD):', date);
    if (input === null) return;
    date = input.trim() || date;
  }
  await api('PATCH', `/api/deposit-slips/${id}/submitted`, { submitted, submitted_date: date });
  await loadAll(); render();
}

async function printDeposit(id) {
  const s = await api('GET', '/api/deposit-slips/' + id);
  const cashItems = s.transactions.filter(t => (t.payment_method || '').toLowerCase() === 'cash');
  const checkItems = s.transactions.filter(t => (t.payment_method || '').toLowerCase() === 'check');
  const otherItems = s.transactions.filter(t => {
    const m = (t.payment_method || '').toLowerCase();
    return m !== 'cash' && m !== 'check';
  });
  const cashTotal = cashItems.reduce((sum, t) => sum + t.amount, 0);
  const checkTotal = checkItems.reduce((sum, t) => sum + t.amount, 0);
  const otherTotal = otherItems.reduce((sum, t) => sum + t.amount, 0);
  const checkCount = checkItems.length;

  const groupTable = (title, rows, total, columns, includeRef) => rows.length === 0 ? '' : `
    <h3>${title}</h3>
    <table>
      <thead><tr>${columns.map(c => `<th${c.num ? ' class="num"' : ''}>${c.h}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map(t => `<tr>
          <td>${esc(t.date)}</td>
          <td>${esc(t.description)}</td>
          ${includeRef ? `<td>${esc(t.reference || '')}</td>` : ''}
          <td class="num">$${Number(t.amount).toFixed(2)}</td>
        </tr>`).join('')}
        <tr><td colspan="${columns.length - 1}"><strong>${title} Subtotal</strong></td><td class="num"><strong>$${total.toFixed(2)}</strong></td></tr>
      </tbody>
    </table>`;

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>FBLA Deposit Slip #${s.id}</title>
    <style>
      body{font:13px Arial,sans-serif;padding:36px;color:#111827;max-width:780px;margin:0 auto;}
      .header{border-bottom:3px solid #003f87;padding-bottom:14px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:flex-end;}
      .header h1{color:#003f87;margin:0;font-size:22px;letter-spacing:0.02em;}
      .header .sub{color:#6b7280;font-size:13px;margin-top:2px;}
      .header .meta{text-align:right;font-size:13px;}
      .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 28px;margin:14px 0 22px;font-size:13px;}
      .meta-grid .label{color:#6b7280;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:0.06em;margin-bottom:2px;}
      .meta-grid .val{color:#111827;border-bottom:1px solid #d1d5db;padding-bottom:4px;min-height:18px;}
      h3{color:#003f87;margin:22px 0 8px;border-left:3px solid #003f87;padding-left:10px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;}
      table{width:100%;border-collapse:collapse;margin-bottom:6px;}
      th,td{padding:6px 10px;border:1px solid #d1d5db;text-align:left;font-size:12px;}
      th{background:#f9fafb;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:10px;letter-spacing:0.04em;}
      td.num,th.num{text-align:right;}
      .summary{margin-top:14px;border:2px solid #003f87;padding:12px 16px;display:flex;justify-content:space-between;background:#f8fafc;}
      .summary .grand{font-size:18px;font-weight:bold;color:#003f87;}
      .summary .breakdown{font-size:12px;color:#6b7280;}
      .notes{margin-top:18px;padding:10px 12px;border:1px solid #d1d5db;background:#fafafa;}
      .notes .label{font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:600;letter-spacing:0.06em;margin-bottom:4px;}
      .sig-block{margin-top:42px;display:grid;grid-template-columns:1fr 1fr;gap:36px;}
      .sig{}
      .sig .role{font-size:10px;color:#6b7280;text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:24px;}
      .sig .name{border-bottom:1px solid #111827;padding:2px 4px;font-size:13px;min-height:18px;}
      .sig .sig-line{border-bottom:1px solid #111827;margin-top:22px;height:24px;}
      .sig .caption{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;margin-top:4px;}
      .sig .date-line{margin-top:18px;display:flex;gap:8px;align-items:flex-end;font-size:11px;color:#6b7280;}
      .sig .date-line .line{flex:1;border-bottom:1px solid #111827;height:18px;}
      .footer{margin-top:32px;padding-top:12px;border-top:1px solid #d1d5db;font-size:11px;color:#6b7280;text-align:center;}
    </style></head><body>
    <div class="header">
      <div>
        <h1>FBLA Chapter Deposit Slip</h1>
        <div class="sub">${esc(chapterName())} Chapter</div>
      </div>
      <div class="meta">
        <div><strong>Slip #:</strong> ${s.id}</div>
        <div><strong>Date Prepared:</strong> ${esc(s.date)}</div>
      </div>
    </div>

    <div class="meta-grid">
      <div>
        <div class="label">Activity Account #</div>
        <div class="val">${esc(s.account || '')}</div>
      </div>
      <div>
        <div class="label">Number of Checks</div>
        <div class="val">${checkCount}</div>
      </div>
      <div style="grid-column:span 2;">
        <div class="label">Purpose / Source of Funds</div>
        <div class="val">${esc(s.purpose || '')}</div>
      </div>
    </div>

    ${s.transactions.length === 0 ? '<p style="color:#6b7280;">No transactions in this slip.</p>' : ''}
    ${groupTable('Cash', cashItems, cashTotal, [{ h: 'Date' }, { h: 'Source' }, { h: 'Amount', num: true }], false)}
    ${groupTable('Checks', checkItems, checkTotal, [{ h: 'Date' }, { h: 'Payer / Source' }, { h: 'Check #' }, { h: 'Amount', num: true }], true)}
    ${groupTable('Other Payments', otherItems, otherTotal, [{ h: 'Date' }, { h: 'Source' }, { h: 'Method / Ref' }, { h: 'Amount', num: true }], true)}

    <div class="summary">
      <div class="breakdown">
        Cash: $${cashTotal.toFixed(2)},
        Checks: $${checkTotal.toFixed(2)}${otherTotal > 0 ? `, Other: $${otherTotal.toFixed(2)}` : ''}
      </div>
      <div class="grand">Total Deposit: $${s.total.toFixed(2)}</div>
    </div>

    ${s.notes ? `<div class="notes"><div class="label">Notes</div>${esc(s.notes)}</div>` : ''}

    <div class="sig-block">
      <div class="sig">
        <div class="role">Chapter Treasurer</div>
        <div class="name">${esc(s.deposited_by || '')}</div>
        <div class="caption">Printed Name</div>
        <div class="sig-line"></div>
        <div class="caption">Signature</div>
        <div class="date-line"><span>Date:</span><span class="line"></span></div>
      </div>
      <div class="sig">
        <div class="role">Chapter Advisor</div>
        <div class="name">${esc(s.advisor || '')}</div>
        <div class="caption">Printed Name</div>
        <div class="sig-line"></div>
        <div class="caption">Signature</div>
        <div class="date-line"><span>Date:</span><span class="line"></span></div>
      </div>
    </div>

    <script>setTimeout(function(){window.print();},300);<\/script>
    </body></html>`);
  w.document.close();
}

async function deleteDeposit(id) {
  if (!confirm('Delete this deposit slip? The income transactions will remain (they will become available for a new slip).')) return;
  await api('DELETE', '/api/deposit-slips/' + id);
  await loadAll(); render();
}

// ===== Purchase Orders =====
function renderPurchaseOrders() {
  $('#tab-purchase-orders').innerHTML = `
    <h2>Purchase Orders</h2>
    <p style="color:var(--muted);margin:0 0 16px;">Bundle expense transactions into a purchase order for the school. Transactions are not duplicated. Mark as submitted when turned in.</p>
    <div class="toolbar">
      <button class="btn" onclick="openPOForm()" ${state.canEdit ? '' : 'disabled'}>+ New Purchase Order</button>
    </div>
    <table>
      <thead><tr><th>PO #</th><th>Date</th><th>Vendor</th><th>Purpose</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${state.purchaseOrders.length === 0 ? `<tr><td colspan="8" class="empty">No purchase orders yet.</td></tr>` : state.purchaseOrders.map(p => `
          <tr>
            <td>${esc(p.po_number)}</td>
            <td>${esc(p.date)}</td>
            <td>${esc(p.vendor_name)}</td>
            <td>${esc(p.purpose || '')}</td>
            <td>${p.tx_count || 0}</td>
            <td><strong>${fmt(p.total)}</strong></td>
            <td>${p.submitted
              ? `<span class="badge paid">Submitted</span><div style="font-size:11px;color:var(--muted);">${esc(p.submitted_date || '')}</div>`
              : `<span class="badge unpaid">Pending</span>`}
            </td>
            <td>
              <button class="btn small secondary" onclick="printPO(${p.id})">Print / PDF</button>
              ${state.canEdit ? (p.submitted
                ? `<button class="btn small secondary" onclick="togglePOSubmitted(${p.id}, false)">Unmark</button>`
                : `<button class="btn small gold" onclick="togglePOSubmitted(${p.id}, true)">Mark Submitted</button>`) : ''}
              ${state.canEdit ? `<button class="btn small danger" onclick="deletePO(${p.id})">Delete</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function openPOForm() {
  const available = state.transactions.filter(t => t.type === 'expense' && !t.purchase_order_id);
  if (available.length === 0) {
    showModal('New Purchase Order', `
      <p>There are no expense transactions available for a PO. Record expense transactions first, then create a purchase order to wrap them.</p>
    `, async () => true, 'Close');
    return;
  }
  showModal('New Purchase Order', `
    <div class="form-row"><label>Date</label><input id="po-date" type="date" value="${today()}" /></div>
    <div class="form-row"><label>Vendor Name</label><input id="po-vendor" /></div>
    <div class="form-row"><label>Vendor Address</label><input id="po-vaddr" /></div>
    <div class="form-row"><label>Vendor Phone</label><input id="po-vphone" /></div>
    <div class="form-row"><label>Ship To</label><input id="po-ship" value="${esc(chapterName())} Chapter" /></div>
    <div class="form-row"><label>Activity Account #</label><input id="po-acct" placeholder="FBLA activity fund #" /></div>
    <div class="form-row"><label>Purpose</label><input id="po-purpose" placeholder="Reason for purchase" /></div>
    <div class="form-row"><label>Payment Method</label>
      <select id="po-pm"><option>Check</option><option>Card</option><option>Cash</option><option>Reimbursement</option><option>Other</option></select>
    </div>
    <div class="form-row"><label>Treasurer</label><input id="po-req" value="${esc(state.user || '')}" /></div>
    <div class="form-row"><label>Advisor</label><input id="po-auth" placeholder="Advisor full name" /></div>
    <div class="form-row"><label>Notes</label><textarea id="po-notes" rows="2"></textarea></div>
    <h3 style="margin-top:18px;font-size:14px;color:var(--fbla-blue);">Select expense transactions for this PO</h3>
    <div style="display:flex;gap:8px;margin:8px 0;">
      <button class="btn small secondary" type="button" onclick="poSelectAll(true)">Select All</button>
      <button class="btn small secondary" type="button" onclick="poSelectAll(false)">Clear</button>
    </div>
    <div style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;">
      <table style="border:none;">
        <thead><tr><th style="width:32px;"></th><th>Date</th><th>Description</th><th>Category</th><th>Method</th><th style="text-align:right;">Amount</th></tr></thead>
        <tbody>${available.map(t => `
          <tr>
            <td><input type="checkbox" class="po-tx" data-id="${t.id}" data-amt="${t.amount}" data-desc="${esc(t.description)}" onchange="recalcPO()" /></td>
            <td>${esc(t.date)}</td>
            <td>${esc(t.description)}</td>
            <td>${esc(t.category || '')}</td>
            <td>${esc(t.payment_method || '')}</td>
            <td style="text-align:right;"><strong>${fmt(t.amount)}</strong></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p style="text-align:right;margin-top:14px;font-size:16px;font-weight:700;color:var(--text);">
      Selected Total: <span id="po-total">$0.00</span>
    </p>
  `, async () => {
    const ids = [];
    $$('.po-tx:checked').forEach(c => ids.push(Number(c.dataset.id)));
    if (ids.length === 0) { alert('Select at least one transaction.'); return false; }
    if (!$('#po-vendor').value.trim()) {
      const guess = $$('.po-tx:checked')[0]?.dataset.desc || '';
      if (!confirm(`No vendor name entered. Use first transaction description "${guess}" as vendor?`)) {
        alert('Please enter a vendor name.');
        return false;
      }
      $('#po-vendor').value = guess;
    }
    await api('POST', '/api/purchase-orders', {
      date: $('#po-date').value,
      vendor_name: $('#po-vendor').value,
      vendor_address: $('#po-vaddr').value,
      vendor_phone: $('#po-vphone').value,
      ship_to: $('#po-ship').value,
      requested_by: $('#po-req').value,
      authorized_by: $('#po-auth').value,
      account: $('#po-acct').value,
      purpose: $('#po-purpose').value,
      payment_method: $('#po-pm').value,
      notes: $('#po-notes').value,
      transaction_ids: ids
    });
    await loadAll(); render();
    return true;
  }, 'Create PO');
}

window.poSelectAll = function(state) {
  $$('.po-tx').forEach(c => { c.checked = state; });
  recalcPO();
};

window.recalcPO = function() {
  let total = 0;
  $$('.po-tx:checked').forEach(c => total += Number(c.dataset.amt) || 0);
  const el = $('#po-total');
  if (el) el.textContent = fmt(total);
};

async function togglePOSubmitted(id, submitted) {
  let date = today();
  if (submitted) {
    const input = prompt('Date submitted to school (YYYY-MM-DD):', date);
    if (input === null) return;
    date = input.trim() || date;
  }
  await api('PATCH', `/api/purchase-orders/${id}/submitted`, { submitted, submitted_date: date });
  await loadAll(); render();
}

async function printPO(id) {
  const p = await api('GET', '/api/purchase-orders/' + id);
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>FBLA Purchase Order ${p.po_number}</title>
    <style>
      body{font:13px Arial,sans-serif;padding:36px;color:#111827;max-width:780px;margin:0 auto;}
      .header{border-bottom:3px solid #003f87;padding-bottom:14px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:flex-end;}
      .header h1{color:#003f87;margin:0;font-size:22px;letter-spacing:0.02em;}
      .header .sub{color:#6b7280;font-size:13px;margin-top:2px;}
      .header .meta{text-align:right;font-size:13px;}
      .boxes{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0;}
      .box{border:1px solid #d1d5db;padding:12px 14px;border-left:3px solid #003f87;}
      .box h3{margin:0 0 6px;color:#003f87;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;}
      .box .row{font-size:13px;margin:2px 0;}
      .meta-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 22px;margin:14px 0 18px;font-size:13px;}
      .meta-grid .label{color:#6b7280;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:0.06em;margin-bottom:2px;}
      .meta-grid .val{color:#111827;border-bottom:1px solid #d1d5db;padding-bottom:4px;min-height:18px;}
      h3.section{color:#003f87;margin:18px 0 8px;border-left:3px solid #003f87;padding-left:10px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;}
      table{width:100%;border-collapse:collapse;margin:6px 0 12px;}
      th,td{padding:6px 10px;border:1px solid #d1d5db;text-align:left;font-size:12px;}
      th{background:#f9fafb;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:10px;letter-spacing:0.04em;}
      td.num,th.num{text-align:right;}
      .summary{margin-top:6px;border:2px solid #003f87;padding:10px 16px;display:flex;justify-content:flex-end;background:#f8fafc;align-items:center;gap:18px;}
      .summary .grand{font-size:18px;font-weight:bold;color:#003f87;}
      .notes{margin-top:14px;padding:10px 12px;border:1px solid #d1d5db;background:#fafafa;}
      .notes .label{font-size:10px;text-transform:uppercase;color:#6b7280;font-weight:600;letter-spacing:0.06em;margin-bottom:4px;}
      .sig-block{margin-top:42px;display:grid;grid-template-columns:1fr 1fr;gap:36px;}
      .sig .role{font-size:10px;color:#6b7280;text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:24px;}
      .sig .name{border-bottom:1px solid #111827;padding:2px 4px;font-size:13px;min-height:18px;}
      .sig .sig-line{border-bottom:1px solid #111827;margin-top:22px;height:24px;}
      .sig .caption{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;margin-top:4px;}
      .sig .date-line{margin-top:18px;display:flex;gap:8px;align-items:flex-end;font-size:11px;color:#6b7280;}
      .sig .date-line .line{flex:1;border-bottom:1px solid #111827;height:18px;}
      .footer{margin-top:32px;padding-top:12px;border-top:1px solid #d1d5db;font-size:11px;color:#6b7280;text-align:center;}
    </style></head><body>
    <div class="header">
      <div>
        <h1>FBLA Chapter Purchase Order</h1>
        <div class="sub">${esc(chapterName())} Chapter</div>
      </div>
      <div class="meta">
        <div><strong>PO #:</strong> ${esc(p.po_number)}</div>
        <div><strong>Date:</strong> ${esc(p.date)}</div>
      </div>
    </div>

    <div class="boxes">
      <div class="box">
        <h3>Vendor</h3>
        <div class="row"><strong>${esc(p.vendor_name)}</strong></div>
        ${p.vendor_address ? `<div class="row">${esc(p.vendor_address)}</div>` : ''}
        ${p.vendor_phone ? `<div class="row">${esc(p.vendor_phone)}</div>` : ''}
      </div>
      <div class="box">
        <h3>Ship To</h3>
        <div class="row">${esc(p.ship_to)}</div>
      </div>
    </div>

    <div class="meta-grid">
      <div>
        <div class="label">Activity Account #</div>
        <div class="val">${esc(p.account || '')}</div>
      </div>
      <div>
        <div class="label">Payment Method</div>
        <div class="val">${esc(p.payment_method || '')}</div>
      </div>
      <div>
        <div class="label">Item Count</div>
        <div class="val">${p.transactions.length}</div>
      </div>
      <div style="grid-column:span 3;">
        <div class="label">Purpose</div>
        <div class="val">${esc(p.purpose || '')}</div>
      </div>
    </div>

    <h3 class="section">Items</h3>
    <table>
      <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Method</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${p.transactions.length === 0 ? '<tr><td colspan="5" style="color:#6b7280;text-align:center;">No items.</td></tr>' :
          p.transactions.map(t => `<tr>
            <td>${esc(t.date)}</td>
            <td>${esc(t.description)}</td>
            <td>${esc(t.category || '')}</td>
            <td>${esc(t.payment_method || '')}</td>
            <td class="num">$${Number(t.amount).toFixed(2)}</td>
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="summary">
      <div class="grand">Total: $${p.total.toFixed(2)}</div>
    </div>

    ${p.notes ? `<div class="notes"><div class="label">Notes</div>${esc(p.notes)}</div>` : ''}

    <div class="sig-block">
      <div class="sig">
        <div class="role">Chapter Treasurer</div>
        <div class="name">${esc(p.requested_by || '')}</div>
        <div class="caption">Printed Name</div>
        <div class="sig-line"></div>
        <div class="caption">Signature</div>
        <div class="date-line"><span>Date:</span><span class="line"></span></div>
      </div>
      <div class="sig">
        <div class="role">Chapter Advisor</div>
        <div class="name">${esc(p.authorized_by || '')}</div>
        <div class="caption">Printed Name</div>
        <div class="sig-line"></div>
        <div class="caption">Signature</div>
        <div class="date-line"><span>Date:</span><span class="line"></span></div>
      </div>
    </div>

    <script>setTimeout(function(){window.print();},300);<\/script>
    </body></html>`);
  w.document.close();
}

async function deletePO(id) {
  if (!confirm('Delete this purchase order? The expense transactions will remain (they will become available for a new PO).')) return;
  await api('DELETE', '/api/purchase-orders/' + id);
  await loadAll(); render();
}

// ===== Audit log =====
function renderAudit() {
  $('#tab-audit').innerHTML = `
    <h2>Activity Log</h2>
    <table>
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>
        ${state.audit.length === 0 ? `<tr><td colspan="4" class="empty">No activity yet.</td></tr>` : state.audit.map(a => `
          <tr>
            <td>${esc(a.timestamp)}</td>
            <td>${esc(a.user_name || '')}</td>
            <td>${esc(a.action)}</td>
            <td style="font-family:monospace;font-size:12px;">${esc(a.details || '')}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

// ===== Calendar (shared grid + officer tab) =====
const CAL_KIND_META = {
  event: { label: 'Event', cls: 'cal-event' },
  meeting: { label: 'Meeting', cls: 'cal-meeting' },
  deadline: { label: 'Deadline', cls: 'cal-deadline' },
  other: { label: 'Other', cls: 'cal-other' },
};

// Built-in kinds plus any custom event types the chapter configured. Custom
// types reuse the neutral "other" styling but carry their own color.
function calKindMeta(kind) {
  if (CAL_KIND_META[kind]) return { ...CAL_KIND_META[kind], color: null };
  const c = calEventTypes().find(t => t.key === kind);
  if (c) return { label: c.label, cls: 'cal-other', color: c.color || null };
  return { ...CAL_KIND_META.other, color: null };
}

function calMonthLabel(y, m) {
  return new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Expand items onto every day they cover: single-day items land on their date;
// items with an end_date also appear on each day through the end (marked _cont
// after day one so the grid can style the continuation). Span capped at 120
// days as a runaway guard.
function calExpandByDate(items) {
  const byDate = new Map();
  const push = (ds, it) => { const arr = byDate.get(ds) || []; arr.push(it); byDate.set(ds, arr); };
  (items || []).forEach(it => {
    if (!it.date) return;
    push(it.date, it);
    if (it.end_date && it.end_date > it.date) {
      let d = new Date(it.date + 'T00:00:00Z');
      const end = new Date(it.end_date + 'T00:00:00Z');
      let guard = 0;
      while (d < end && guard++ < 120) {
        d = new Date(d.getTime() + 86400000);
        push(d.toISOString().slice(0, 10), { ...it, _cont: true });
      }
    }
  });
  return byDate;
}

function calendarGridHTML(items, cursor, opts = {}) {
  const { y, m } = cursor;
  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayStr = today();
  const byDate = calExpandByDate(items);
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell cal-blank"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayItems = byDate.get(ds) || [];
    const click = opts.pop ? ` onclick="${opts.pop}('${ds}', event)"` : '';
    cells += `<div class="cal-cell ${ds === todayStr ? 'cal-today' : ''} ${opts.pop ? 'cal-clickable' : ''}"${click}>
      <div class="cal-daynum">${d}</div>
      ${dayItems.map(it => {
        const meta = calKindMeta(it.kind);
        const del = opts.canDelete && it.source === 'custom' && !it._cont
          ? `<button class="cal-del" title="Remove from calendar" onclick="event.stopPropagation();${opts.del || 'deleteCalendarItem'}(${it.id})">×</button>` : '';
        return `<div class="cal-item ${meta.cls} ${it._cont ? 'cal-cont' : ''}"${meta.color ? ` style="background:${meta.color};border-color:${meta.color};color:#fff;"` : ''} title="${esc(it.title)}${it.description ? ': ' + esc(it.description) : ''}">${it._cont ? '<span class="cal-cont-arrow">›</span> ' : ''}${it.time && !it._cont ? `<span class="cal-time">${esc(it.time)}</span> ` : ''}${esc(it.title)}${del}</div>`;
      }).join('')}
    </div>`;
  }
  return `
    <div class="cal-head">
      <button class="btn small secondary" type="button" onclick="${opts.nav}(-1)">&lsaquo; Prev</button>
      <div class="cal-title">${calMonthLabel(y, m)}</div>
      <button class="btn small secondary" type="button" onclick="${opts.nav}(1)">Next &rsaquo;</button>
    </div>
    <div class="cal-grid cal-dow">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend">
      <span class="cal-item cal-meeting">Meeting</span>
      <span class="cal-item cal-event">Event</span>
      <span class="cal-item cal-deadline">Deadline</span>
      <span class="cal-item cal-other">Other</span>
    </div>`;
}

// ---- Day popover: click a date to see its items next to the cell ----
// Officers get Edit/Delete on custom items plus an "add on this date" shortcut.
window.closeCalPopover = function() {
  const p = document.getElementById('cal-popover');
  if (p) p.remove();
  document.removeEventListener('click', calPopoverOutside, true);
};
function calPopoverOutside(e) {
  const p = document.getElementById('cal-popover');
  if (p && !p.contains(e.target)) closeCalPopover();
}
function showCalDayPopover(ds, ev, items, opts = {}) {
  if (ev) ev.stopPropagation();
  closeCalPopover();
  const dayItems = (calExpandByDate(items).get(ds) || []);
  // A spanning item appears once in the popup (with its full range), not once
  // per continuation day.
  const seen = new Set();
  const uniq = dayItems.filter(it => {
    const key = `${it.source}:${it.id}:${it.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dateLabel = new Date(ds + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const srcLabel = { event: 'from Events', payment: 'payment deadline' };
  const rows = uniq.map(it => {
    const meta = calKindMeta(it.kind);
    const range = it.end_date ? ` <span class="cal-pop-range">${esc(it.date)} to ${esc(it.end_date)}</span>` : '';
    const actions = (opts.editable && it.source === 'custom')
      ? `<div class="cal-pop-actions">
           <button class="btn small secondary" onclick="closeCalPopover();${opts.editFn}(${it.id})">Edit</button>
           <button class="btn small danger" onclick="closeCalPopover();${opts.delFn}(${it.id})">Delete</button>
         </div>`
      : (opts.editable && srcLabel[it.source] ? `<div class="cal-pop-src">${srcLabel[it.source]}</div>` : '');
    return `<div class="cal-pop-item">
      <div class="cal-pop-line">
        <span class="cal-item ${meta.cls}" style="position:static;${meta.color ? `background:${meta.color};border-color:${meta.color};color:#fff;` : ''}">${esc(meta.label)}</span>
        <strong>${esc(it.title)}</strong>
      </div>
      <div class="cal-pop-meta">${it.time ? esc(it.time) : 'All day'}${it.location ? `, ${esc(it.location)}` : ''}${range}</div>
      ${it.description ? `<div class="cal-pop-desc">${esc(it.description)}</div>` : ''}
      ${it.created_by ? `<div class="cal-pop-src">Added by ${esc(it.created_by)}</div>` : ''}
      ${actions}
    </div>`;
  }).join('');
  const pop = document.createElement('div');
  pop.id = 'cal-popover';
  pop.className = 'cal-popover';
  pop.innerHTML = `
    <div class="cal-pop-head">
      <strong>${esc(dateLabel)}</strong>
      <button class="cal-pop-close" onclick="closeCalPopover()" aria-label="Close">×</button>
    </div>
    ${rows || '<div class="cal-pop-empty">Nothing on this day.</div>'}
    ${opts.editable && opts.addFn ? `<button class="btn small" style="margin-top:10px;width:100%;" onclick="closeCalPopover();${opts.addFn}(null,'${ds}')">+ Add on this date</button>` : ''}
  `;
  document.body.appendChild(pop);
  // Position beside the clicked cell, clamped to the viewport.
  const cell = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect
    ? ev.currentTarget.getBoundingClientRect() : { right: window.innerWidth / 2, left: window.innerWidth / 2 - 150, top: 100, bottom: 130 };
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = cell.right + 8;
  if (left + pw > window.innerWidth - 10) left = cell.left - pw - 8;
  if (left < 10) left = Math.max(10, Math.min(window.innerWidth - pw - 10, cell.left));
  let top = cell.top;
  if (top + ph > window.innerHeight - 10) top = Math.max(10, window.innerHeight - ph - 10);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  setTimeout(() => document.addEventListener('click', calPopoverOutside, true), 0);
}
window.calDayPopup = function(ds, ev) {
  showCalDayPopover(ds, ev, state.calendar, {
    editable: state.canEdit,
    editFn: 'editCalendarItem', delFn: 'deleteCalendarItem', addFn: 'openCalendarForm',
  });
};
window.offCalDayPopup = function(ds, ev) {
  showCalDayPopover(ds, ev, state.officerCalendar, {
    editable: state.canEdit,
    editFn: 'editOfficerCalendarItem', delFn: 'deleteOfficerCalendarItem', addFn: 'openOfficerCalendarForm',
  });
};
window.editCalendarItem = function(id) { openCalendarForm(id); };
window.editOfficerCalendarItem = function(id) { openOfficerCalendarForm(id); };

function shiftCursor(cursor, delta) {
  const d = new Date(cursor.y, cursor.m + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}

function ensureCursor(key) {
  if (!state[key]) {
    const n = new Date();
    state[key] = { y: n.getFullYear(), m: n.getMonth() };
  }
  return state[key];
}

function renderOfficerCalendar() {
  const el = $('#tab-calendar');
  if (!el) return;
  const cursor = ensureCursor('calCursor');
  const upcoming = (state.calendar || []).filter(c => c.date && c.date >= today()).slice(0, 15);
  el.innerHTML = `
    <h2>Calendar</h2>
    <p class="hint">This is the public chapter calendar. It combines the dates you add here, a connected Google Calendar, and your Events with their payment due dates. Everything on it shows on the public hub.</p>
    <div class="toolbar">
      <button class="btn" onclick="openCalendarForm()" ${state.canEdit ? '' : 'disabled'}>+ Add to Calendar</button>
    </div>
    ${googleCalPanelHTML()}
    <div class="panel">${calendarGridHTML(state.calendar, cursor, { nav: 'navCal', canDelete: state.canEdit, pop: 'calDayPopup' })}</div>
    <div class="panel">
      <h3>Upcoming</h3>
      ${upcoming.length ? `
        <table>
          <thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Title</th><th>Location</th><th>Notes</th><th></th></tr></thead>
          <tbody>${upcoming.map(c => `
            <tr>
              <td>${esc(c.date)}${c.end_date ? ` <span class="muted" style="font-size:11px;">to ${esc(c.end_date)}</span>` : ''}</td>
              <td>${esc(c.time || '')}</td>
              <td><span class="badge neutral"${calKindMeta(c.kind).color ? ` style="background:${calKindMeta(c.kind).color};color:#fff;"` : ''}>${calKindMeta(c.kind).label}</span>${c.source !== 'custom' ? ' <span class="muted" style="font-size:11px;">synced</span>' : ''}</td>
              <td>${esc(c.title)}</td>
              <td>${esc(c.location || '')}</td>
              <td>${esc(c.description || '')}</td>
              <td>${state.canEdit && c.source === 'custom' ? `<button class="btn small secondary" onclick="openCalendarForm(${c.id})">Edit</button> <button class="btn small danger" onclick="deleteCalendarItem(${c.id})">Delete</button>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">Nothing on the calendar yet.</div>'}
    </div>
  `;
}

window.navCal = function(delta) {
  state.calCursor = shiftCursor(ensureCursor('calCursor'), delta);
  renderOfficerCalendar();
};

// --- Google Calendar connection (public iCal link -> chapter calendar) ---
// Connect once (URL saved in settings), then any officer can re-sync with one
// click. Sync is idempotent: events match by iCal UID, so re-running updates
// changed dates instead of duplicating them.
function googleCalPanelHTML() {
  const s = state.settings || {};
  const url = (s.google_calendar_ical_url || '').trim();
  let last = null;
  try { last = s.google_calendar_last_sync ? JSON.parse(s.google_calendar_last_sync) : null; } catch (e) { last = null; }
  return `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>Google Calendar</h3>
          <p class="hint" style="margin:2px 0 0;">${url
            ? `Connected. Syncing pulls that calendar's events onto the chapter calendar. Re-syncing updates changed dates, it never duplicates.${last ? ` Last sync ${esc(relTime(String(last.at || '').replace('T', ' ').slice(0, 19)))}: ${last.added} added, ${last.updated} updated, ${last.unchanged} unchanged.` : ''}`
            : 'Connect a Google Calendar and its events flow onto the chapter calendar. In Google Calendar: Settings for your calendar, "Integrate calendar", copy the public iCal address.'}</p>
        </div>
        <span class="badge ${url ? 'paid' : 'neutral'}">${url ? 'Connected' : 'Not connected'}</span>
      </div>
      <div class="settings-row">
        ${url ? `
          <button class="btn" onclick="runGoogleCalSync(false)" ${state.canEdit ? '' : 'disabled'}>Sync now</button>
          <button class="btn secondary" onclick="runGoogleCalSync(true)">Preview changes</button>
          <button class="btn secondary danger" onclick="disconnectGoogleCal()" ${state.canEdit ? '' : 'disabled'}>Disconnect</button>
        ` : `
          <button class="btn" onclick="openGoogleCalConnect()" ${state.canEdit ? '' : 'disabled'}>Connect a calendar</button>
        `}
      </div>
    </div>`;
}

window.openGoogleCalConnect = function() {
  showModal('Connect a Google Calendar', `
    <p class="hint">In Google Calendar, open <strong>Settings</strong> for the calendar you want, scroll to <strong>Integrate calendar</strong>, and copy the <strong>public address in iCal format</strong> (the calendar must be public; the secret iCal address works too). Paste it here.</p>
    <div class="form-row"><label>iCal link</label><input id="gcal-url" placeholder="https://calendar.google.com/calendar/ical/..." /></div>
    <p class="hint">Connecting runs a preview first, nothing is added until you apply it.</p>
  `, async () => {
    const url = $('#gcal-url').value.trim();
    if (!url) { alert('Paste the iCal link first.'); return false; }
    let preview;
    try { preview = await api('POST', '/api/calendar/google-sync', { ical_url: url, dry_run: true }); }
    catch (e) { alert(e.message); return false; }
    try { await api('PUT', '/api/calendar/google-sync', { ical_url: url }); }
    catch (e) { alert(e.message); return false; }
    await loadAll();
    showGoogleCalPreview(preview, url);
    return true;
  }, 'Connect & Preview');
};

// Preview modal: shows what a sync would do; OK applies it for real.
function showGoogleCalPreview(p, url) {
  const rows = (p.items || []).map(i => `<tr><td>${i.action === 'add' ? '<span class="badge paid">Add</span>' : '<span class="badge neutral">Update</span>'}</td><td>${esc(i.title)}</td><td>${esc(i.date)}</td></tr>`).join('');
  showModal('Google Calendar preview', `
    <p class="hint">Found <strong>${p.parsed}</strong> event${p.parsed === 1 ? '' : 's'} in the feed: ${p.added} to add, ${p.updated} to update, ${p.unchanged} already up to date${p.skipped ? `, ${p.skipped} skipped (no date/title)` : ''}.</p>
    ${rows ? `<table><thead><tr><th></th><th>Event</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>${(p.added + p.updated) > (p.items || []).length ? `<p class="hint">Showing the first ${(p.items || []).length} changes.</p>` : ''}` : '<div class="empty">Everything is already in sync.</div>'}
  `, async () => {
    if (!(p.added + p.updated)) return true;
    try { await api('POST', '/api/calendar/google-sync', { ical_url: url || undefined, dry_run: false }); }
    catch (e) { alert(e.message); return false; }
    await loadAll(); render();
    return true;
  }, (p.added + p.updated) ? 'Apply sync' : 'Close');
}

window.runGoogleCalSync = async function(dryRun) {
  try {
    const r = await api('POST', '/api/calendar/google-sync', { dry_run: !!dryRun });
    if (dryRun) { showGoogleCalPreview(r); return; }
    await loadAll(); render();
    alert(`Synced: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged.`);
  } catch (e) { alert(e.message); }
};

window.disconnectGoogleCal = async function() {
  if (!confirm('Disconnect this Google Calendar? Events already on the chapter calendar stay; they just stop syncing.')) return;
  try { await api('PUT', '/api/calendar/google-sync', { ical_url: '' }); }
  catch (e) { alert(e.message); return; }
  await loadAll(); render();
};

// --- Officer-only calendar (private to the officer console) ---
function renderOfficerPrivateCalendar() {
  const el = $('#tab-officer-calendar');
  if (!el) return;
  const cursor = ensureCursor('offCalCursor');
  const items = state.officerCalendar || [];
  const upcoming = items.filter(c => c.date && c.date >= today()).slice(0, 15);
  el.innerHTML = `
    <h2>Officer Calendar</h2>
    <p class="hint">A private calendar just for the officer team. Anything you add here shows only in this console, never on the public hub. Any officer, treasurer, president, or advisor can add to it.</p>
    <div class="toolbar">
      <button class="btn" onclick="openOfficerCalendarForm()" ${state.canEdit ? '' : 'disabled'}>+ Add to Officer Calendar</button>
    </div>
    <div class="panel">${calendarGridHTML(items, cursor, { nav: 'navOffCal', canDelete: state.canEdit, del: 'deleteOfficerCalendarItem', pop: 'offCalDayPopup' })}</div>
    <div class="panel">
      <h3>Upcoming</h3>
      ${upcoming.length ? `
        <table>
          <thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Title</th><th>Notes</th><th>Added By</th><th></th></tr></thead>
          <tbody>${upcoming.map(c => `
            <tr>
              <td>${esc(c.date)}</td>
              <td>${esc(c.time || '')}</td>
              <td><span class="badge neutral"${calKindMeta(c.kind).color ? ` style="background:${calKindMeta(c.kind).color};color:#fff;"` : ''}>${calKindMeta(c.kind).label}</span></td>
              <td>${esc(c.title)}</td>
              <td>${esc(c.description || '')}</td>
              <td>${esc(c.created_by || '')}</td>
              <td>${state.canEdit ? `<button class="btn small danger" onclick="deleteOfficerCalendarItem(${c.id})">Delete</button>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">Nothing on the officer calendar yet.</div>'}
    </div>
  `;
}

window.navOffCal = function(delta) {
  state.offCalCursor = shiftCursor(ensureCursor('offCalCursor'), delta);
  renderOfficerPrivateCalendar();
};

function openOfficerCalendarForm(id, presetDate) {
  const it = id ? (state.officerCalendar || []).find(c => c.id === id) : null;
  if (id && !it) { alert('That calendar item is no longer there.'); return; }
  showModal(it ? 'Edit Officer Calendar Item' : 'Add to Officer Calendar', `
    <div class="form-row"><label>Title</label><input id="oc-title" placeholder="e.g. Officer planning meeting" value="${it ? esc(it.title) : ''}" /></div>
    <div class="form-row"><label>Type</label>
      <select id="oc-kind">
        ${['meeting', 'event', 'deadline', 'other'].map(k => `<option value="${k}" ${it && it.kind === k ? 'selected' : ''}>${k.charAt(0).toUpperCase() + k.slice(1)}</option>`).join('')}
      </select>
    </div>
    <div class="form-row"><label>Date</label><input id="oc-date" type="date" value="${it ? esc(it.date) : (presetDate || today())}" /></div>
    <div class="form-row"><label>End date (optional, for spanning dates)</label><input id="oc-end-date" type="date" value="${it && it.end_date ? esc(it.end_date) : ''}" /></div>
    <div class="form-row"><label>Time (optional)</label><input id="oc-time" type="time" value="${it && it.time ? esc(it.time) : ''}" /></div>
    <div class="form-row"><label>Details</label><textarea id="oc-desc" rows="2">${it && it.description ? esc(it.description) : ''}</textarea></div>
    <p class="hint">This stays private to the officer team.</p>
  `, async () => {
    const title = $('#oc-title').value.trim();
    if (!title) { alert('Title required'); return false; }
    if (!$('#oc-date').value) { alert('Date required'); return false; }
    const endDate = $('#oc-end-date').value || null;
    if (endDate && endDate < $('#oc-date').value) { alert('End date must be on or after the start date.'); return false; }
    const body = {
      title,
      kind: $('#oc-kind').value,
      date: $('#oc-date').value,
      end_date: endDate,
      time: $('#oc-time').value || null,
      description: $('#oc-desc').value.trim() || null,
    };
    if (it) await api('PUT', '/api/officer-calendar/' + it.id, body);
    else await api('POST', '/api/officer-calendar', body);
    try { state.officerCalendar = await api('GET', '/api/officer-calendar'); } catch (e) {}
    renderOfficerPrivateCalendar();
    return true;
  }, it ? 'Save Changes' : 'Add');
}
window.openOfficerCalendarForm = openOfficerCalendarForm;

window.deleteOfficerCalendarItem = async function(id) {
  if (!confirm('Remove this officer calendar item?')) return;
  await api('DELETE', '/api/officer-calendar/' + id);
  try { state.officerCalendar = await api('GET', '/api/officer-calendar'); } catch (e) {}
  renderOfficerPrivateCalendar();
};

function openCalendarForm(id, presetDate) {
  const it = id ? (state.calendar || []).find(c => c.source === 'custom' && c.id === id) : null;
  if (id && !it) { alert('That calendar item is no longer there.'); return; }
  showModal(it ? 'Edit Calendar Item' : 'Add to Calendar', `
    <div class="form-row"><label>Title</label><input id="c-title" placeholder="e.g. Chapter meeting" value="${it ? esc(it.title) : ''}" /></div>
    <div class="form-row"><label>Type</label>
      <select id="c-kind">
        ${['meeting', 'event', 'deadline', 'other'].map(k => `<option value="${k}" ${it && it.kind === k ? 'selected' : ''}>${k.charAt(0).toUpperCase() + k.slice(1)}</option>`).join('')}
        ${calEventTypes().map(t => `<option value="${esc(t.key)}" ${it && it.kind === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
      </select>
    </div>
    <div class="form-row"><label>Date</label><input id="c-date" type="date" value="${it ? esc(it.date) : (presetDate || today())}" /></div>
    <div class="form-row"><label>End date (optional, for spanning dates)</label><input id="c-end-date" type="date" value="${it && it.end_date ? esc(it.end_date) : ''}" /><span class="hint" style="margin-top:4px;">Leave blank for a single day. A range like a conference shows on every day it covers.</span></div>
    <div class="form-row"><label>Time (optional)</label><input id="c-time" type="time" value="${it && it.time ? esc(it.time) : ''}" /></div>
    <div class="form-row"><label>Location (optional)</label><input id="c-location" maxlength="120" placeholder="e.g. LGI B229" value="${it && it.location ? esc(it.location) : ''}" /></div>
    <div class="form-row"><label>Details</label><textarea id="c-desc" rows="2">${it && it.description ? esc(it.description) : ''}</textarea></div>
    <p class="hint">Everything on this calendar is public. Events already appear here, so you only need to add stand-alone chapter dates.</p>
  `, async () => {
    const title = $('#c-title').value.trim();
    if (!title) { alert('Title required'); return false; }
    if (!$('#c-date').value) { alert('Date required'); return false; }
    const endDate = $('#c-end-date').value || null;
    if (endDate && endDate < $('#c-date').value) { alert('End date must be on or after the start date.'); return false; }
    const body = {
      title,
      kind: $('#c-kind').value,
      date: $('#c-date').value,
      end_date: endDate,
      time: $('#c-time').value || null,
      location: $('#c-location').value.trim(),
      description: $('#c-desc').value.trim() || null,
    };
    if (it) await api('PUT', '/api/calendar/' + it.id, body);
    else await api('POST', '/api/calendar', body);
    await loadAll(); render();
    return true;
  }, it ? 'Save Changes' : 'Add');
}
window.openCalendarForm = openCalendarForm;

window.deleteCalendarItem = async function(id) {
  if (!confirm('Remove this calendar item?')) return;
  await api('DELETE', '/api/calendar/' + id);
  await loadAll(); render();
};

// ===== Officer: Email =====
// A composer for one-off email to the officer team. There are no student
// accounts, so there are no student addresses: the server resolves the officer
// team's addresses itself (POST /api/email/compose). The draft lives in state,
// not in the DOM, so a background re-render can't wipe what an officer types.
function emailDraft() {
  if (!state.emailDraft) {
    state.emailDraft = { subject: '', body: '', greet: true };
  }
  return state.emailDraft;
}
window.emailDraftSet = function(key, value) { emailDraft()[key] = value; };

function emailStatusPanelHtml() {
  const st = state.email;
  if (!st) {
    return `<div class="panel"><h3>Email delivery</h3><p style="color:var(--muted)">Could not read the email status. Reload the page to try again.</p></div>`;
  }
  if (!st.configured) {
    return `
      <div class="panel">
        <h3>Email delivery</h3>
        <p style="color:var(--muted)">Email is <strong>not set up yet</strong>, so nothing can be sent. An adult with access to the hosting dashboard needs to add a Resend API key (<code>ResendAPI</code>) or SMTP credentials to the environment variables.</p>
      </div>`;
  }
  const admin = !!st.can_manage;
  return `
    <div class="panel">
      <h3>Email delivery</h3>
      <p style="color:var(--muted)">
        Email is working${st.transport ? ` through <strong>${esc(st.transport)}</strong>` : ''}${st.from ? `, sent from <strong>${esc(st.from)}</strong>` : ''}.
      </p>
      ${admin ? `
      <p style="color:var(--muted)">Emailed password-reset codes for officers are <strong>${resetEmailOn() ? 'on' : 'off'}</strong>.
        ${resetEmailOn()
          ? 'An officer who forgets their password can request a code from the sign-in page.'
          : 'While they are off, the president or advisor resets forgotten passwords in Settings.'}</p>
      <div class="settings-row" style="gap:8px;flex-wrap:wrap;">
        <button class="btn secondary" onclick="toggleResetEmail(${resetEmailOn() ? 'false' : 'true'})">${resetEmailOn() ? 'Turn reset emails off' : 'Turn reset emails on'}</button>
        <button class="btn secondary" onclick="sendEmailTest()">Send a test email</button>
      </div>` : ''}
    </div>`;
}

function renderOfficerEmail() {
  const el = $('#tab-email');
  if (!el) return;
  const d = emailDraft();
  const st = state.email;
  const canSend = !!(st && st.configured) && state.canEdit;
  const recent = (state.audit || []).filter(a => String(a.action || '').startsWith('email_')).slice(0, 12);

  el.innerHTML = `
    <h2>Email</h2>
    <p class="hint">Email the officer team from here. The hub looks up every active officer account with an email on file. Students have no accounts, so chapter-wide news goes in Announcements, where anyone can read it on the hub.</p>

    ${emailStatusPanelHtml()}

    <div class="panel">
      <h3>Start from</h3>
      <p style="color:var(--muted)">These fill in a subject and message using what is already in the hub. Edit anything before you send.</p>
      <div class="settings-row" style="gap:8px;flex-wrap:wrap;">
        <button class="btn secondary" onclick="emailTemplate('announcement')">Latest announcement</button>
        <button class="btn secondary" onclick="emailTemplate('event')">An event</button>
        <button class="btn secondary" onclick="emailTemplate('meeting')">A calendar date</button>
        <button class="btn secondary" onclick="emailTemplate('week')">The week ahead</button>
        <button class="btn secondary" onclick="emailTemplate('blank')">Blank</button>
      </div>
    </div>

    <div class="panel">
      <h3>Compose</h3>
      <div class="form-row">
        <label>Send to</label>
        <input value="The officer team" disabled />
      </div>
      <div class="form-row">
        <label>Subject</label>
        <input id="em-subject" maxlength="150" value="${esc(d.subject)}" placeholder="e.g. Officer meeting moved to Thursday" oninput="emailDraftSet('subject', this.value)" />
      </div>
      <div class="form-row">
        <label>Message</label>
        <textarea id="em-body" rows="12" placeholder="Write the email here. Line breaks are kept, and it goes out in the chapter's email design." oninput="emailDraftSet('body', this.value)">${esc(d.body)}</textarea>
      </div>
      <div class="form-row">
        <label>Greeting</label>
        <label style="display:flex;align-items:center;gap:8px;">
          <input id="em-greet" type="checkbox" ${d.greet ? 'checked' : ''} style="width:auto;" onchange="emailDraftSet('greet', this.checked)" />
          <span>Start each email with the person's first name</span>
        </label>
      </div>
      <div id="em-preview"></div>
      <div class="settings-row" style="gap:8px;flex-wrap:wrap;">
        <button class="btn secondary" onclick="previewEmailRecipients()">See who gets this</button>
        <button class="btn" onclick="sendComposedEmail()" ${canSend ? '' : 'disabled'}>Send email</button>
      </div>
      ${canSend ? '' : '<p class="hint">Sending is unavailable until email credentials are set up.</p>'}
    </div>

    <div class="panel">
      <h3>Recent email activity</h3>
      ${recent.length ? `
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>${recent.map(a => `
            <tr>
              <td>${esc(a.timestamp || '')}</td>
              <td>${esc(a.user_name || '')}</td>
              <td>${esc(a.details || a.action || '')}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No email has been sent from the hub yet.</div>'}
    </div>
  `;
}

// Fill the composer from something already in the hub.
window.emailTemplate = function(kind) {
  const d = emailDraft();
  const setDraft = (subject, body) => { d.subject = subject; d.body = body; renderOfficerEmail(); };

  if (kind === 'blank') { setDraft('', ''); return; }

  if (kind === 'announcement') {
    const a = (state.announcements || [])[0];
    if (!a) { alert('There are no announcements to start from yet.'); return; }
    setDraft(a.title || '', `${a.body || ''}\n\nThis is also posted on the chapter hub.`);
    return;
  }

  if (kind === 'week') {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const items = (state.calendar || [])
      .filter(it => it.date && it.date >= today && it.date <= horizon)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!items.length) { alert('Nothing is on the chapter calendar in the next 7 days.'); return; }
    const lines = items.map(it => `- ${it.date}${it.time ? ` at ${it.time}` : ''}: ${it.title}${it.description ? ` (${it.description})` : ''}`);
    setDraft('FBLA: what is happening this week',
      `Here is what the chapter has coming up in the next week:\n\n${lines.join('\n')}\n\nEverything is on the chapter hub calendar too.`);
    return;
  }

  if (kind === 'event') {
    const events = state.events || [];
    if (!events.length) { alert('There are no events to start from yet.'); return; }
    showModal('Start from an event', `
      <div class="form-row"><label>Event</label>
        <select id="em-tpl-event">${events.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      </div>
      <p class="hint">This fills in the subject and message with the event's date and cost. You can edit it before sending.</p>
    `, async () => {
      const ev = events.find(e => String(e.id) === $('#em-tpl-event').value);
      if (!ev) return false;
      const bits = [];
      if (ev.date) bits.push(`When: ${ev.date}${ev.time ? ' at ' + fmtTime(ev.time) : ''}`);
      if (ev.location) bits.push(`Where: ${ev.location}`);
      if (Number(ev.cost_per_member) > 0) bits.push(`Cost: $${Number(ev.cost_per_member).toFixed(2)}`);
      if (ev.first_payment_due) bits.push(`First payment due: ${ev.first_payment_due}`);
      if (Number(ev.second_payment_amount) > 0 && ev.second_payment_due) {
        bits.push(`Second payment ($${Number(ev.second_payment_amount).toFixed(2)}) due: ${ev.second_payment_due}`);
      }
      d.subject = `FBLA: ${ev.name}`;
      d.body = `${ev.description ? ev.description + '\n\n' : ''}${bits.join('\n')}\n\n` +
        `The full details are on the chapter hub.`;
      renderOfficerEmail();
      return true;
    }, 'Use this event');
    return;
  }

  if (kind === 'meeting') {
    const today = new Date().toISOString().slice(0, 10);
    const items = (state.calendar || []).filter(it => it.date && it.date >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 40);
    if (!items.length) { alert('There is nothing upcoming on the chapter calendar.'); return; }
    showModal('Start from a calendar date', `
      <div class="form-row"><label>Date</label>
        <select id="em-tpl-cal">${items.map((it, i) => `<option value="${i}">${esc(it.date)} - ${esc(it.title)}</option>`).join('')}</select>
      </div>
    `, async () => {
      const it = items[Number($('#em-tpl-cal').value)];
      if (!it) return false;
      d.subject = `FBLA: ${it.title}`;
      d.body = `${it.title} is on ${it.date}${it.time ? ` at ${it.time}` : ''}.\n\n` +
        `${it.description ? it.description + '\n\n' : ''}Hope to see you there.`;
      renderOfficerEmail();
      return true;
    }, 'Use this date');
    return;
  }
};

// Resolve the audience on the server and show it, without sending anything.
window.previewEmailRecipients = async function() {
  const box = $('#em-preview');
  const d = emailDraft();
  box.innerHTML = '<p class="hint">Checking...</p>';
  try {
    const r = await api('POST', '/api/email/compose', { ...composePayload(d), preview: true });
    if (!r.total) {
      box.innerHTML = '<p class="hint">No active officer account has an email address on file, so there is nobody to send to.</p>';
      return;
    }
    const SHOW = 30;
    const names = r.recipients.slice(0, SHOW).map(x => esc(x.name)).join(', ');
    const more = r.total > SHOW ? ` and ${r.total - SHOW} more` : '';
    box.innerHTML = `<p class="hint"><strong>${r.total} recipient${r.total === 1 ? '' : 's'}:</strong> ${names}${more}</p>`;
  } catch (e) {
    box.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
};

function composePayload(d) {
  return { subject: d.subject, body: d.body, greet: d.greet };
}

window.sendComposedEmail = async function() {
  const d = emailDraft();
  if (!d.subject.trim()) { alert('Give the email a subject.'); return; }
  if (!d.body.trim()) { alert('Write a message before sending.'); return; }
  // Confirm against the real, server-resolved audience: a mass email cannot be
  // taken back, so the officer sees the exact count before it goes.
  let preview;
  try {
    preview = await api('POST', '/api/email/compose', { ...composePayload(d), preview: true });
  } catch (e) { alert(e.message); return; }
  if (!preview.total) { alert('No active officer account has an email address on file.'); return; }
  if (!confirm(`Send "${d.subject.trim()}" to ${preview.total} recipient${preview.total === 1 ? '' : 's'}? This cannot be undone.`)) return;

  try {
    const r = await api('POST', '/api/email/compose', composePayload(d));
    state.emailDraft = null;
    await loadAll();
    render();
    switchTab('email');
    alert(r.failed
      ? `Sent to ${r.sent} of ${r.total}. ${r.failed} failed${r.error ? `: ${r.error}` : '.'}`
      : `Sent to ${r.sent} recipient${r.sent === 1 ? '' : 's'}.`);
  } catch (e) { alert(e.message); }
};

// Emailed reset codes are off unless the setting says '1' (never written =
// off), so no database change was needed to disable them.
function resetEmailOn() {
  return String((state.settings || {}).password_reset_email_enabled || '') === '1';
}

window.toggleResetEmail = async function(enabled) {
  if (!enabled && !confirm('Turn off emailed reset codes? Officers who forget a password will need the president or advisor to reset it.')) return;
  await api('PATCH', '/api/settings/password-reset-email', { enabled });
  await loadAll();
  render();
};

window.sendEmailTest = async function() {
  showModal('Send a test email', `
    <div class="form-row"><label>Send to</label><input id="em-test-to" type="email" placeholder="you@example.com" /></div>
    <p class="hint">A short test message, so you can check the chapter's email actually arrives.</p>
  `, async () => {
    const to = $('#em-test-to').value.trim();
    if (!to) { alert('Enter an email address.'); return false; }
    await api('POST', '/api/email/test', { to });
    alert('Test email sent.');
    return true;
  }, 'Send test');
};

// ===== Officer: Announcements =====
// Announcements are public: they show on the hub's home page and Announcements
// page for anyone who opens the site. The category drives the hub's filter tabs.
const ANNOUNCEMENT_CATEGORIES = ['Chapter news', 'Competition', 'Deadlines', 'Resources'];

function renderOfficerAnnouncements() {
  const el = $('#tab-announcements');
  if (!el) return;
  const items = state.announcements || [];
  el.innerHTML = `
    <h2>Announcements</h2>
    <p class="hint">Announcements appear on the public chapter hub for everyone. Pinned announcements stay at the top and show on the hub's home page.</p>
    <div class="toolbar">
      <button class="btn" onclick="openAnnouncementForm()" ${state.canEdit ? '' : 'disabled'}>+ New Announcement</button>
    </div>
    <div class="panel">
      ${items.length ? `
        <table>
          <thead><tr><th>Title</th><th>Message</th><th>Category</th><th>Posted By</th><th>Posted</th><th>Pinned</th><th></th></tr></thead>
          <tbody>${items.map(a => `
            <tr>
              <td><strong>${esc(a.title)}</strong> ${a.pinned ? '<span class="badge gold-badge">📌 Pinned</span>' : ''}</td>
              <td>${esc(a.body || '')}</td>
              <td><span class="badge neutral">${esc(a.category || 'Chapter news')}</span></td>
              <td>${esc(a.created_by || '')}</td>
              <td>${esc(a.created_at || '')}</td>
              <td><button class="btn small secondary" onclick="toggleAnnouncementPin(${a.id}, ${a.pinned ? 'false' : 'true'})">${a.pinned ? 'Unpin' : 'Pin'}</button></td>
              <td><button class="btn small danger" onclick="deleteAnnouncement(${a.id})">Delete</button></td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No announcements yet.</div>'}
    </div>
  `;
}

function openAnnouncementForm() {
  showModal('New Announcement', `
    <div class="form-row"><label>Title</label><input id="an-title" placeholder="e.g. State conference registration open" /></div>
    <div class="form-row"><label>Message</label><textarea id="an-body" rows="4"></textarea></div>
    <div class="form-row"><label>Category</label>
      <select id="an-category">${ANNOUNCEMENT_CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('')}</select>
    </div>
    <div class="form-row"><label>Pin</label>
      <label style="display:flex;align-items:center;gap:8px;">
        <input id="an-pinned" type="checkbox" style="width:auto;" />
        <span>Pin to the top of the hub</span>
      </label>
    </div>
    <p class="hint">This is posted publicly on the chapter hub.</p>
  `, async () => {
    const title = $('#an-title').value.trim();
    if (!title) { alert('Title required'); return false; }
    await api('POST', '/api/announcements', {
      title,
      body: $('#an-body').value.trim(),
      category: $('#an-category').value,
      pinned: $('#an-pinned').checked ? 1 : 0,
    });
    await loadAll(); render();
    return true;
  }, 'Post');
}

window.toggleAnnouncementPin = async function(id, pinned) {
  await api('PATCH', `/api/announcements/${id}/pinned`, { pinned });
  await loadAll(); render();
};

window.deleteAnnouncement = async function(id) {
  if (!confirm('Delete this announcement?')) return;
  await api('DELETE', '/api/announcements/' + id);
  await loadAll(); render();
};

// ===== Officer: Google Forms =====
// The hub has no form builder and stores no responses. Officers paste a Google
// Form link here and it shows on the hub's Forms page; everything a student
// types goes to Google, under the chapter's Google account. "Hide from hub"
// keeps the link here but takes it off the public page.
const isGoogleFormUrl = (u) => /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/|forms\.google\.com\/)/i.test(String(u || '').trim());

function renderOfficerGoogleForms() {
  const el = $('#tab-google-forms');
  if (!el) return;
  const forms = state.googleForms || [];
  const row = (f) => `
    <tr ${f.open ? '' : 'style="opacity:0.55;"'}>
      <td><strong>${esc(f.title)}</strong>${f.required ? ' <span class="req-star" title="Required">*</span>' : ''} ${f.open ? '<span class="badge paid">On the site</span>' : '<span class="badge unpaid">Hidden</span>'}${f.required ? ' <span class="badge overdue">Required</span>' : ''}${f.popup ? ` <span class="badge gold-badge">${f.open ? 'Pops up' : 'Pop-up paused (hidden)'}</span>` : ''}${f.open && f.due_date && f.due_date < today() ? ' <span class="badge overdue">Past respond-by date</span>' : ''}</td>
      <td>${f.url ? `<a href="${safeUrl(f.url)}" target="_blank" rel="noopener">Open form ↗</a>` : '<span class="muted">none</span>'}</td>
      <td>${esc(f.description || '')}</td>
      <td>${f.event_name ? `<span class="badge neutral">${esc(f.event_name)}</span>` : '<span class="muted">general</span>'}</td>
      <td>${f.due_date ? esc(f.due_date) : '<span class="muted">none</span>'}</td>
      <td>${esc(f.created_by || '')}</td>
      <td>
        <button class="btn small ${f.popup ? 'secondary' : 'gold'}" onclick="toggleGoogleFormPopup(${f.id}, ${f.popup ? 'false' : 'true'})" title="${f.popup ? 'Stop this form from popping up on the site' : 'Make this form pop up when someone opens the site'}">${f.popup ? 'Stop pop-up' : 'Pop up'}</button>
        <button class="btn small secondary" onclick="openGoogleFormForm(${f.id})">Edit</button>
        <button class="btn small secondary" onclick="toggleGoogleForm(${f.id}, ${f.open ? 'false' : 'true'})">${f.open ? 'Hide from hub' : 'Show on hub'}</button>
        <button class="btn small danger" onclick="deleteGoogleForm(${f.id})">Delete</button>
      </td>
    </tr>`;
  el.innerHTML = `
    <h2>Google Forms</h2>
    <p class="hint">Share a Google Form with the chapter: interest forms, trip paperwork, feedback. It shows on the Forms page of the site. <strong>Pop up</strong> makes a form open on screen when someone visits the site; they can open it, say they've filled it out, or be reminded next visit. Responses go to your Google account, and the hub never stores them. Set the form's own settings in Google (for example, whether it collects email addresses).</p>
    <div class="panel">
      <div class="panel-head">
        <h3>Forms on the hub</h3>
        <button class="btn" onclick="openGoogleFormForm()" ${state.canEdit ? '' : 'disabled'}>+ Add Google Form</button>
      </div>
      ${forms.length ? `
        <table>
          <thead><tr><th>Title</th><th>Link</th><th>Description</th><th>Event</th><th>Respond By</th><th>Added By</th><th></th></tr></thead>
          <tbody>${forms.map(row).join('')}</tbody>
        </table>` : '<div class="empty">No forms yet. Paste a Google Form link to put it on the hub.</div>'}
    </div>
  `;
}

window.openGoogleFormForm = function(id) {
  const f = id ? (state.googleForms || []).find(x => x.id === id) : null;
  if (id && !f) { alert('That form is no longer there.'); return; }
  showModal(f ? 'Edit Google Form' : 'Add Google Form', `
    <div class="form-row"><label>Title</label><input id="gf-title" maxlength="120" placeholder="e.g. States trip permission form" value="${f ? esc(f.title) : ''}" /></div>
    <div class="form-row"><label>Google Form link</label><input id="gf-url" placeholder="https://forms.gle/..." value="${f ? esc(f.url || '') : ''}" />
      <span class="hint" style="margin-top:4px;">In Google Forms, press <strong>Send</strong>, pick the link tab, and copy it.</span></div>
    <div class="form-row"><label>Description (optional)</label><textarea id="gf-desc" rows="2" maxlength="600">${f ? esc(f.description || '') : ''}</textarea></div>
    <div class="form-row"><label>For Chapter Event (optional)</label>
      <select id="gf-event">
        <option value="">General</option>
        ${state.events.map(e => `<option value="${e.id}" ${f && f.event_id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
      </select>
    </div>
    <div class="form-row"><label>Respond by (optional)</label><input id="gf-due" type="date" value="${f && f.due_date ? esc(f.due_date) : ''}" />
      <span class="hint" style="margin-top:4px;">Shown on the form's card. The form stays on the site until you hide it.</span></div>
    <div class="form-row"><label>Required</label>
      <label style="display:flex;align-items:center;gap:8px;">
        <input id="gf-required" type="checkbox" ${f && f.required ? 'checked' : ''} style="width:auto;" />
        <span>Mark this form as required (a red <strong style="color:#b91c1c">*</strong> on the site)</span>
      </label>
    </div>
    ${f ? '' : `<div class="form-row"><label>Pop up</label>
      <label style="display:flex;align-items:center;gap:8px;">
        <input id="gf-popup" type="checkbox" style="width:auto;" />
        <span>Pop this form up when someone opens the site</span>
      </label>
    </div>`}
  `, async () => {
    const body = {
      title: $('#gf-title').value.trim(),
      url: $('#gf-url').value.trim(),
      description: $('#gf-desc').value.trim(),
      event_id: $('#gf-event').value || null,
      due_date: $('#gf-due').value || null,
      required: $('#gf-required').checked ? 1 : 0,
      popup: $('#gf-popup') ? ($('#gf-popup').checked ? 1 : 0) : undefined,
    };
    if (!body.title) { alert('Title required'); return false; }
    if (!body.url) { alert('Paste the Google Form link.'); return false; }
    if (!isGoogleFormUrl(body.url) && !confirm('That link does not look like a Google Form. Add it anyway?')) return false;
    if (f) await api('PUT', '/api/google-forms/' + f.id, body);
    else await api('POST', '/api/google-forms', body);
    await loadAll(); render();
    return true;
  }, f ? 'Save Changes' : 'Add Form');
};

window.toggleGoogleFormPopup = async function(id, popup) {
  await api('PATCH', `/api/google-forms/${id}/popup`, { popup });
  await loadAll(); render();
};

window.toggleGoogleForm = async function(id, open) {
  await api('PATCH', `/api/google-forms/${id}/open`, { open });
  await loadAll(); render();
};

window.deleteGoogleForm = async function(id) {
  if (!confirm('Delete this form link from the hub? The Google Form itself and its responses are not affected.')) return;
  await api('DELETE', '/api/google-forms/' + id);
  await loadAll(); render();
};

// ===== Settings =====
function isAdminRole() {
  return state.officerRole === 'president' || state.officerRole === 'advisor';
}
// The balance, transactions, deposit slips, and purchase orders are limited to
// the treasurer, president, and advisor (enforced server-side too).
function canFinance() {
  return state.canEdit && (state.officerRole === 'treasurer' || state.officerRole === 'president' || state.officerRole === 'advisor');
}

function officerAccountsPanelHtml() {
  if (!isAdminRole()) return '';
  const officers = state.officers || [];
  return `
    <div class="panel">
      <h3>Officer Accounts</h3>
      <p style="color:var(--muted)">Give each officer their own login so the activity log shows who really did what. The chapter master password keeps working as the advisor-level backup. Only the President and Advisor can add officers, change their roles, or set their passwords.</p>
      ${officers.length ? `
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Leadership Title</th><th>Status</th><th></th></tr></thead>
          <tbody>${officers.map(o => `
            <tr ${o.active ? '' : 'style="opacity:0.55;"'}>
              <td><strong>${esc(o.name)}</strong></td>
              <td>${esc(o.email || '')}</td>
              <td><span class="badge neutral">${esc(o.role)}</span></td>
              <td>${o.title ? esc(o.title) : '<span class="muted">-</span>'}</td>
              <td><span class="badge ${o.active ? 'paid' : 'unpaid'}">${o.active ? 'Active' : 'Disabled'}</span></td>
              <td>
                <button class="btn small secondary" onclick="openOfficerEditForm(${o.id})">Edit</button>
                <button class="btn small secondary" onclick="resetOfficerPassword(${o.id})">Reset Password</button>
                <button class="btn small secondary" onclick="toggleOfficerActive(${o.id}, ${o.active ? 'false' : 'true'})">${o.active ? 'Disable' : 'Enable'}</button>
                <button class="btn small danger" onclick="deleteOfficerAccount(${o.id})">Delete</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No individual officer accounts yet. Add one below so officers do not have to share the chapter password.</div>'}
      <div class="settings-row" style="margin-top:10px;">
        <button class="btn" onclick="openOfficerForm()">+ Add Officer Account</button>
      </div>
      <div class="settings-toggle-row" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft);">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;">
          <input type="checkbox" id="strict-login" ${state.settings.officer_login_strict === '1' ? 'checked' : ''} onchange="toggleStrictLogin(this.checked)" style="width:auto;margin-top:3px;" />
          <span>
            <strong>Require officer accounts to sign in</strong><br>
            <span style="color:var(--muted);font-size:12.5px;">When this is on, the shared chapter password stops working, so only officers with their own name and password (listed above) can sign in. Flip it on once everyone has an account.</span>
          </span>
        </label>
      </div>
    </div>`;
}

window.toggleStrictLogin = async function(enabled) {
  try {
    await api('PUT', '/api/settings/officer-login-strict', { enabled });
    await loadAll(); render();
    alert(enabled
      ? 'Strict mode on: only officer accounts can sign in now. The chapter password is disabled.'
      : 'Strict mode off: the chapter password works again.');
  } catch (e) {
    alert(e.message);
    const box = $('#strict-login');
    if (box) box.checked = !enabled;
  }
};

function openOfficerForm() {
  showModal('Add Officer Account', `
    <div class="form-row"><label>Name</label><input id="of-name" placeholder="Full name (used to sign in)" /></div>
    <div class="form-row"><label>Email (optional, can also sign in with it)</label><input id="of-email" type="email" /></div>
    <div class="form-row"><label>Role</label>
      <select id="of-role">
        <option value="officer">Officer</option>
        <option value="treasurer">Treasurer</option>
        <option value="president">President</option>
        <option value="advisor">Advisor</option>
      </select>
    </div>
    <div class="form-row"><label>Title on Leadership Team (optional)</label>
      <input id="of-title" placeholder="e.g. Historian, VP of Marketing" />
      <p class="hint" style="margin-top:4px;">Shown on the public About page. Leave blank to just use the role name.</p>
    </div>
    <div class="form-row"><label>Password (min 6 characters)</label><input id="of-pass" type="password" /></div>
    <p class="hint">The President and Advisor manage officer accounts and passwords. The Treasurer (plus President and Advisor) handles the treasury. Every officer can edit events, the calendar, announcements, forms, and resources.</p>
  `, async () => {
    const body = {
      name: $('#of-name').value.trim(),
      email: $('#of-email').value.trim(),
      role: $('#of-role').value,
      title: $('#of-title').value.trim(),
      password: $('#of-pass').value,
    };
    if (!body.name) { alert('Name required'); return false; }
    if (body.password.length < 6) { alert('Password must be at least 6 characters.'); return false; }
    await api('POST', '/api/officers', body);
    await loadAll(); render();
    return true;
  }, 'Create Account');
}
window.openOfficerForm = openOfficerForm;

// Edit an existing officer's role and Leadership Team title (also lets you set
// titles on accounts created before this field existed, e.g. President/Advisor).
window.openOfficerEditForm = function(id) {
  const o = (state.officers || []).find(x => x.id === id);
  if (!o) return;
  showModal('Edit Officer', `
    <p class="hint">${esc(o.name)}</p>
    <div class="form-row"><label>Role</label>
      <select id="of-edit-role">
        <option value="officer" ${o.role === 'officer' ? 'selected' : ''}>Officer</option>
        <option value="treasurer" ${o.role === 'treasurer' ? 'selected' : ''}>Treasurer</option>
        <option value="president" ${o.role === 'president' ? 'selected' : ''}>President</option>
        <option value="advisor" ${o.role === 'advisor' ? 'selected' : ''}>Advisor</option>
      </select>
    </div>
    <div class="form-row"><label>Title on Leadership Team (optional)</label>
      <input id="of-edit-title" placeholder="e.g. Historian, VP of Marketing" value="${esc(o.title || '')}" />
      <p class="hint" style="margin-top:4px;">Leave blank to just use the role name.</p>
    </div>
  `, async () => {
    try {
      await api('PUT', '/api/officers/' + id, { role: $('#of-edit-role').value, title: $('#of-edit-title').value.trim() });
    } catch (e) { alert(e.message); return false; }
    await loadAll(); render();
    return true;
  }, 'Save');
};

window.resetOfficerPassword = async function(id) {
  const pass = prompt('New password for this officer (min 6 characters):');
  if (pass === null) return;
  if (pass.length < 6) { alert('Password must be at least 6 characters.'); return; }
  await api('PUT', '/api/officers/' + id, { password: pass });
  alert('Password updated.');
};

window.toggleOfficerActive = async function(id, active) {
  await api('PUT', '/api/officers/' + id, { active });
  await loadAll(); render();
};

window.deleteOfficerAccount = async function(id) {
  if (!confirm('Delete this officer account? They will no longer be able to sign in with it.')) return;
  await api('DELETE', '/api/officers/' + id);
  await loadAll(); render();
};

function googleSheetsBackupPanelHtml() {
  if (state.officerRole !== 'president' && state.officerRole !== 'advisor') return '';
  const backup = state.sheetsBackup || { state: 'unknown', lastError: 'Backup status is unavailable.' };
  const ready = backup.state === 'ready';
  const failed = backup.state === 'error';
  const syncing = backup.state === 'syncing';
  const badgeClass = ready ? 'paid' : (failed || backup.state === 'not_configured' ? 'unpaid' : 'neutral');
  const badgeText = ready ? 'Up to date' : (syncing ? 'Syncing' : (failed ? 'Sync failed' : (backup.state === 'pending' ? 'Ready to sync' : 'Setup needed')));
  let lastSync = 'No successful sync yet';
  if (backup.lastSuccessAt) {
    const parsed = new Date(backup.lastSuccessAt);
    lastSync = Number.isNaN(parsed.getTime()) ? backup.lastSuccessAt : parsed.toLocaleString();
  }
  return `
    <div class="panel">
      <div class="panel-head">
        <div><h3>Google Sheets Backup</h3><p class="hint">A complete recovery snapshot runs after every database change.</p></div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="backup-status-grid">
        <div><span>Last successful sync</span><strong>${esc(lastSync)}</strong></div>
        <div><span>Collections copied</span><strong>${Object.keys(backup.rowCounts || {}).length}</strong></div>
        <div><span>Backup rows</span><strong>${Object.values(backup.rowCounts || {}).reduce((sum, count) => sum + Number(count || 0), 0)}</strong></div>
      </div>
      ${backup.lastError ? `<p class="backup-warning">${esc(backup.lastError)}</p>` : ''}
      <div class="settings-row">
        <button class="btn" type="button" onclick="syncGoogleSheetsBackup()" ${syncing ? 'disabled' : ''}>Sync to Google Sheets now</button>
        ${backup.spreadsheetUrl ? `<a class="btn secondary" href="${esc(backup.spreadsheetUrl)}" target="_blank" rel="noopener">Open backup workbook</a>` : ''}
      </div>
    </div>`;
}

function renderSettings() {
  const start = state.settings.starting_balance || '3320.97';
  // A shared-chapter-password session has no officer account (officerId is null),
  // so there is no password of its own to change.
  const isAccountSession = !!state.officerId;
  $('#tab-settings').innerHTML = `
    <h2>Settings</h2>
    <div class="panel">
      <h3>Your Password</h3>
      ${isAccountSession ? `
        <p style="color:var(--muted)">Changes the password for your officer account.</p>
        <div class="form-row"><label>Current password</label><input id="op-current" type="password" autocomplete="current-password" /></div>
        <div class="form-row"><label>New password</label>
          <input id="op-new" type="password" placeholder="At least 6 characters" autocomplete="new-password" oninput="renderPasswordStrength('op-strength', this.value, [${jsArg(state.user)}])" />
          <div id="op-strength" class="pw-strength hidden" aria-live="polite">
            <div class="pw-strength-bar"><span></span></div>
            <span class="pw-strength-text"></span>
          </div>
        </div>
        <div class="form-row"><label>Confirm new password</label><input id="op-confirm" type="password" autocomplete="new-password" /></div>
        <div class="settings-row"><button class="btn" onclick="changeOfficerPassword()">Change password</button></div>`
      : `<p style="color:var(--muted)">You are signed in with the shared chapter password, which has no account of its own, so there is nothing to change here. Sign in with your own officer account to set its password.</p>`}
    </div>
    <div class="panel">
      <h3>Starting Balance</h3>
      <p style="color:var(--muted)">The chapter's balance before any tracked transactions. Affects the current balance calculation.</p>
      <div class="settings-row">
        <input id="s-start" type="number" step="0.01" value="${esc(start)}" ${canFinance() ? '' : 'disabled'} />
        <button class="btn" onclick="saveStartingBalance()" ${canFinance() ? '' : 'disabled'}>Save</button>
      </div>
      ${canFinance() ? '' : '<p class="hint" style="margin-top:6px;">Only the treasurer, president, or advisor can change the starting balance.</p>'}
    </div>
    ${handoverPanelHtml()}
    ${systemHealthPanelHtml()}
    ${officerAccountsPanelHtml()}
    ${googleSheetsBackupPanelHtml()}
    <div class="panel">
      <h3>Downloadable Backup</h3>
      <p style="color:var(--muted)">Download the same complete database snapshot as a JSON file for a separate offline copy.</p>
      <div class="settings-row">
        <button class="btn" onclick="downloadBackup()">Download Backup (.json)</button>
      </div>
    </div>
    <div class="panel">
      <h3>About</h3>
      <p>${esc(chapterName())} Hub</p>
      <p style="color:var(--muted);font-size:12px;">Signed in as <strong>${esc(state.user)}</strong>, ${state.canEdit ? 'You can make changes' : 'View only. Enter the chapter password to make changes.'}</p>
    </div>
  `;
}

// ===== Officer handover panel (President/Advisor only) =====
function handoverPanelHtml() {
  if (!isAdminRole()) return '';
  const steps = [
    ['Download a backup', 'Save a full JSON snapshot so the new team always has this year\'s records.', 'downloadBackup()', 'Download Backup'],
    ['Update officer accounts', 'Add next year\'s officers and remove anyone who is leaving in the Officer Accounts panel below. The public About page lists whoever is active.', null, null],
    ['Tidy the hub', 'Archive last year\'s meeting resources and hide Google Forms that are finished, so visitors only see what is current.', "switchTab('slideshows')", 'Go to Meeting Resources'],
  ];
  return `
    <div class="panel">
      <h3>Officer Handover</h3>
      <p style="color:var(--muted)">A short checklist for passing the chapter to next year's officers. Nothing here changes your data until you choose an action.</p>
      <ol style="margin:8px 0 0;padding-left:20px;line-height:1.7;">
        ${steps.map(([t, d, action, label]) => `
          <li style="margin-bottom:10px;">
            <strong>${t}</strong><br/>
            <span style="color:var(--muted);font-size:13px;">${d}</span>
            ${label ? `<br/><button class="btn small secondary" style="margin-top:6px;" onclick="${action}">${label}</button>` : ''}
          </li>`).join('')}
      </ol>
    </div>`;
}

// ===== Customization tab (all officers) =====
function renderCustomization() {
  const el = $('#tab-customization');
  if (!el) return;
  const cfg = chapterConfig();
  const cats = txCategories();
  el.innerHTML = `
    <h2>Customization</h2>
    <p class="hint">Change what the public hub shows, no code needed. Any officer can edit this.</p>
    <div class="panel">
      <h3>Home Card</h3>
      <p style="color:var(--muted)">The big blue card on the hub's home page. Leave it blank and the hub shows the next date on the chapter calendar instead.</p>
      <div class="form-row"><label>Title</label><input id="cz-card-title" maxlength="90" value="${esc(cfg.home_card_title || '')}" placeholder="e.g. Join us for our first meeting!" /></div>
      <div class="form-row"><label>Subtext</label><textarea id="cz-card-desc" rows="3" maxlength="400" placeholder="e.g. Our first meeting is Thursday at 8:00 in LGI B229. Everyone is welcome.">${esc(cfg.home_card_desc || '')}</textarea></div>
      <div class="form-row"><label>Button text (optional)</label><input id="cz-card-button" maxlength="40" value="${esc(cfg.home_card_button || '')}" placeholder="e.g. See the calendar" /></div>
      <div class="form-row"><label>Button link (optional)</label><input id="cz-card-link" maxlength="300" value="${esc(cfg.home_card_link || '')}" placeholder="https://... (leave blank to open the calendar)" /><span class="hint" style="margin-top:4px;">If you add a button but no link, it opens the hub's calendar.</span></div>
      <div class="settings-row"><button class="btn" onclick="saveCustomization()">Save</button></div>
    </div>
    <div class="panel">
      <h3>Chapter Details</h3>
      <p style="color:var(--muted)">Rename the chapter and set the transaction categories your treasurer picks from, without touching any code.</p>
      <div class="form-row"><label>Chapter Name</label><input id="cz-name" value="${esc(chapterName())}" maxlength="80" /></div>
      <div class="form-row"><label>Tagline</label><input id="cz-tagline" value="${esc(chapterTagline())}" maxlength="120" /></div>
      <div class="form-row">
        <label>Transaction Categories (one per line)</label>
        <textarea id="cz-cats" rows="6" placeholder="Chapter Dues&#10;Event Dues&#10;Fundraiser&#10;Supplies&#10;Venue">${esc(cats.join('\n'))}</textarea>
        <span class="hint" style="margin-top:4px;">These show up as suggestions when recording a transaction, so categories stay consistent for reporting.</span>
      </div>
      <div class="form-row">
        <label>Custom Calendar Event Types (one per line)</label>
        <textarea id="cz-types" rows="4" placeholder="Fundraiser | #d97706&#10;Competition | #7c3aed&#10;Social">${esc(calEventTypes().map(t => `${t.label} | ${t.color || '#1462d9'}`).join('\n'))}</textarea>
        <span class="hint" style="margin-top:4px;">Adds your own types (beyond Meeting/Event/Deadline/Other) to the calendar. Format: <code>Label | #hexcolor</code>. Color is optional.</span>
      </div>
      <div class="form-row">
        <label>Reminder Lead Time (days)</label>
        <input id="cz-lead" type="number" min="0" max="60" step="1" value="${reminderLeadDays()}" style="max-width:120px;" />
        <span class="hint" style="margin-top:4px;">How many days before a payment deadline the dashboard starts flagging it.</span>
      </div>
      <div class="settings-row"><button class="btn" onclick="saveCustomization()">Save Customization</button></div>
    </div>
    </div>`;
}

window.saveCustomization = async function() {
  const cats = $('#cz-cats').value.split('\n').map(s => s.trim()).filter(Boolean);
  // Each type line is "Label" or "Label | #hexcolor".
  const types = $('#cz-types').value.split('\n').map(line => {
    const [label, color] = line.split('|').map(s => (s || '').trim());
    if (!label) return null;
    return { label, color: /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#1462d9' };
  }).filter(Boolean);
  await api('PUT', '/api/settings/customization', {
    chapter_name: $('#cz-name').value,
    chapter_tagline: $('#cz-tagline').value,
    transaction_categories: cats,
    calendar_event_types: types,
    reminder_lead_days: $('#cz-lead').value,
    home_card_title: $('#cz-card-title').value,
    home_card_desc: $('#cz-card-desc').value,
    home_card_button: $('#cz-card-button').value,
    home_card_link: $('#cz-card-link').value,
  });
  await loadAll(); render();
  applyChapterBranding();
  alert('Customization saved.');
};

// ===== System health panel (President/Advisor only) =====
function systemHealthPanelHtml() {
  if (!isAdminRole()) return '';
  const h = state.systemHealth;
  if (!h) return '';
  const s = h.stats || {};
  const errs = h.recent_errors || [];
  const backupState = h.backup ? (h.backup.state || 'unknown') : 'not configured';
  return `
    <div class="panel">
      <h3>System Health</h3>
      <p style="color:var(--muted)">A quick read on what the public hub is showing and whether background jobs are healthy.</p>
      <div class="dir-stats">
        <div class="dir-stat"><span class="dir-stat-label">Upcoming events</span><span class="dir-stat-val">${s.upcoming_events || 0}</span><span class="dir-stat-sub">on the calendar</span></div>
        <div class="dir-stat"><span class="dir-stat-label">Google Forms</span><span class="dir-stat-val">${s.open_forms || 0}</span><span class="dir-stat-sub">showing on the hub</span></div>
        <div class="dir-stat"><span class="dir-stat-label">Stale resources</span><span class="dir-stat-val ${s.stale_resources ? 'dir-due' : 'dir-ok'}">${s.stale_resources || 0}</span><span class="dir-stat-sub">not reviewed in 6+ months</span></div>
        <div class="dir-stat"><span class="dir-stat-label">Sheets backup</span><span class="dir-stat-val ${backupState === 'ready' ? 'dir-ok' : (backupState === 'error' ? 'dir-due' : '')}">${esc(backupState)}</span><span class="dir-stat-sub">last known state</span></div>
      </div>
      <h4 style="margin:16px 0 6px;font-size:13px;">Recent errors</h4>
      ${errs.length ? `
        <table>
          <thead><tr><th>When</th><th>Where</th><th>Message</th></tr></thead>
          <tbody>${errs.slice(0, 10).map(e => `<tr>
            <td style="white-space:nowrap;">${esc((e.at || '').replace('T', ' ').slice(0, 19))}</td>
            <td>${esc(e.path || '')}</td>
            <td style="font-family:monospace;font-size:11px;">${esc(e.message || '')}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="empty">No errors recorded since the server last started.</div>'}
    </div>`;
}

window.syncGoogleSheetsBackup = async function() {
  try {
    state.sheetsBackup = { ...(state.sheetsBackup || {}), state: 'syncing' };
    renderSettings();
    state.sheetsBackup = await api('POST', '/api/google-sheets-backup/sync');
    renderSettings();
    alert('Google Sheets backup is up to date.');
  } catch (error) {
    try { state.sheetsBackup = await api('GET', '/api/google-sheets-backup/status'); } catch (ignored) {}
    renderSettings();
    alert(error.message);
  }
};

window.downloadBackup = function() {
  window.open('/api/backup');
};

// An officer changes their own password. The server verifies the current one
// and writes the new password onto the linked student account too, so both
// portals stay on the same login.
window.changeOfficerPassword = async function() {
  const cur = $('#op-current').value;
  const next = $('#op-new').value;
  const confirm = $('#op-confirm').value;
  if (!cur) { alert('Enter your current password.'); return; }
  if (next !== confirm) { alert('The new passwords do not match.'); return; }
  const s = passwordStrength(next, [state.user]);
  if (!s.ok) { alert(s.hint || 'Choose a stronger password.'); return; }
  try {
    await api('POST', '/api/officer/password', {
      current_password: cur, new_password: next, confirm_password: confirm,
    });
    render();
    alert('Password changed.');
  } catch (e) { alert(e.message); }
};

async function saveStartingBalance() {
  const amt = $('#s-start').value;
  if (amt.trim() === '' || !Number.isFinite(Number(amt))) { alert('Enter a valid dollar amount.'); return; }
  try {
    await api('PUT', '/api/settings/starting-balance', { amount: amt });
    await loadAll(); render();
    alert('Starting balance saved.');
  } catch (e) { alert(e.message); }
}

// ===== Modal =====
let modalSubmit = null;
let modalSubmitting = false;
let modalPreviousFocus = null;
let modalNoDismiss = false;

function showModal(title, bodyHtml, onSubmit, okLabel = 'Save') {
  if ($('#modal').classList.contains('hidden')) {
    modalPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-ok').textContent = okLabel;
  // Reset the Cancel button each open so any per-modal customization (e.g. the
  // guardian prompt's "Skip for now", or a required form hiding it) can't leak.
  const cancelBtn = $('#modal-cancel');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = closeModal;
  cancelBtn.style.display = '';
  modalNoDismiss = false;
  modalSubmit = onSubmit;
  $('#modal').classList.remove('hidden');
  requestAnimationFrame(() => {
    const firstField = $('#modal-body').querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]');
    (firstField || $('#modal-ok')).focus();
  });
}

function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  modalSubmit = null;
  if (modalPreviousFocus && document.contains(modalPreviousFocus)) modalPreviousFocus.focus();
  modalPreviousFocus = null;
}

// =====================================================================
// ============== Officer: Meeting Resources + Study & Prep ============
// =====================================================================

function resourceStale(s) {
  const ref = s.reviewed_at || (s.created_at || '').slice(0, 10);
  if (!ref) return false;
  const d = new Date(ref + 'T00:00:00');
  if (isNaN(d)) return false;
  return (Date.now() - d.getTime()) > 180 * 24 * 3600 * 1000;
}
// Cover thumbnail for the officer tables (a small note when there isn't one).
function coverThumb(s) {
  return s.has_cover
    ? `<img class="res-thumb" src="/api/slideshows/${s.id}/cover?v=${encodeURIComponent(s.cover_v || '')}" alt="Cover of ${esc(s.title)}" />`
    : '<span class="muted" style="font-size:12px;">Default</span>';
}
function officerLinkRow(s) {
  const tags = [s.event_name, s.competitive_event].filter(Boolean);
  const tag = tags.length ? tags.map(t => `<span class="badge neutral">${esc(t)}</span>`).join(' ') : '<span class="muted">general</span>';
  return `
    <tr ${s.archived ? 'style="opacity:0.55;"' : ''}>
      <td>${coverThumb(s)}</td>
      <td>${esc(s.title)} ${s.archived ? '<span class="badge unpaid">Archived</span>' : ''}${resourceStale(s) ? ' <span class="badge overdue" title="Not reviewed in over 6 months">Needs review</span>' : ''}<div style="font-size:11px;color:var(--muted);">reviewed ${s.reviewed_at ? esc(relTime(s.reviewed_at)) : 'never'}</div></td>
      <td>${s.url ? `<a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : '<span class="muted">none</span>'}</td>
      <td>${esc(s.description || '')}</td>
      <td>${tag}</td>
      <td>${esc(s.created_by || '')}</td>
      <td>
        <button class="btn small secondary" onclick="openCoverForm(${s.id})">Cover</button>
        <button class="btn small secondary" onclick="markResourceReviewed(${s.id})">Mark reviewed</button>
        <button class="btn small secondary" onclick="toggleSlideshowArchived(${s.id}, ${s.archived ? 'false' : 'true'})">${s.archived ? 'Restore' : 'Archive'}</button>
        <button class="btn small danger" onclick="deleteSlideshow(${s.id})">Delete</button>
      </td>
    </tr>`;
}
window.markResourceReviewed = async function(id) {
  await api('PATCH', `/api/slideshows/${id}/reviewed`);
  await loadAll(); render();
};

function renderOfficerSlideshows() {
  const el = $('#tab-slideshows');
  if (!el) return;
  const items = (state.slideshows || []).filter(s => s.kind === 'slideshow');
  el.innerHTML = `
    <h2>Meeting Resources</h2>
    <p class="hint">Agendas, slide decks, minutes, and meeting materials. These show on the hub's Meeting Resources page for anyone; archived items leave the hub but stay here.</p>
    <div class="panel">
      <div class="panel-head">
        <h3>Meeting Resources</h3>
        <button class="btn" onclick="openSlideshowForm('slideshow')">+ Add Meeting Resource</button>
      </div>
      ${items.length ? `
        <table>
          <thead><tr><th>Cover</th><th>Title</th><th>Link</th><th>Description</th><th>Tagged</th><th>Added By</th><th></th></tr></thead>
          <tbody>${items.map(officerLinkRow).join('')}</tbody>
        </table>` : '<div class="empty">No meeting resources yet.</div>'}
    </div>
  `;
}

function renderOfficerResources() {
  const el = $('#tab-resources');
  if (!el) return;
  const items = (state.slideshows || []).filter(s => s.kind === 'resource');
  el.innerHTML = `
    <h2>Study &amp; Prep Resources</h2>
    <p class="hint">Add study guides, rubrics, practice tests, and conference prep. Tag a competitive event so visitors searching the hub's Study &amp; Prep page for that event find it.</p>
    <div class="panel">
      <div class="panel-head">
        <h3>Study &amp; Prep Resources</h3>
        <button class="btn" onclick="openSlideshowForm('resource')">+ Add Study Resource</button>
      </div>
      ${items.length ? `
        <table>
          <thead><tr><th>Cover</th><th>Title</th><th>Link</th><th>Description</th><th>Tagged</th><th>Added By</th><th></th></tr></thead>
          <tbody>${items.map(officerLinkRow).join('')}</tbody>
        </table>` : '<div class="empty">No study resources yet.</div>'}
    </div>
  `;
}

function renderOfficerGeneral() {
  const el = $('#tab-general-resources');
  if (!el) return;
  const items = (state.slideshows || []).filter(s => s.kind === 'general');
  el.innerHTML = `
    <h2>General Resources</h2>
    <p class="hint">Chapter guides, handbooks, useful links, and anything else that isn't from a meeting or for studying. These show on the site's General Resources page; archived items leave the site but stay here.</p>
    <div class="panel">
      <div class="panel-head">
        <h3>General Resources</h3>
        <button class="btn" onclick="openSlideshowForm('general')">+ Add General Resource</button>
      </div>
      ${items.length ? `
        <table>
          <thead><tr><th>Cover</th><th>Title</th><th>Link</th><th>Description</th><th>Tagged</th><th>Added By</th><th></th></tr></thead>
          <tbody>${items.map(officerLinkRow).join('')}</tbody>
        </table>` : '<div class="empty">No general resources yet.</div>'}
    </div>
  `;
}

window.toggleSlideshowArchived = async function(id, archived) {
  await api('PATCH', `/api/slideshows/${id}/archived`, { archived });
  await loadAll(); render();
};
function openSlideshowForm(kind) {
  const label = { resource: 'Study Resource', general: 'General Resource' }[kind] || 'Meeting Resource';
  const placeholder = { resource: 'e.g. Business Management study guide', general: 'e.g. Chapter handbook' }[kind] || 'e.g. Sept 12 meeting slides';
  showModal(`Add ${label}`, `
    <div class="form-row"><label>Title</label><input id="sl-title" placeholder="${placeholder}" /></div>
    <div class="form-row"><label>Link (URL)</label><input id="sl-url" placeholder="https://..." /></div>
    <div class="form-row"><label>Description</label><textarea id="sl-desc" rows="2"></textarea></div>
    <div class="form-row"><label>For Chapter Event (optional)</label>
      <select id="sl-event">
        <option value="">General</option>
        ${state.events.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
      </select>
    </div>
    ${kind === 'resource' ? `
    <div class="form-row"><label>Competitive Event (optional)</label><input id="sl-comp" list="sl-comp-list" placeholder="e.g. Business Management" />
      <datalist id="sl-comp-list">${['All Events', ...(chapterConfig().competitive_events || [])].map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    </div>
    <p class="hint">Tag it "All Events" to put it in the All Events section at the top of Study &amp; Prep. Otherwise it goes under Individual Events, and searching for the event name finds it.</p>` : ''}
    ${coverFieldHtml()}
    <p class="hint">This is public on the chapter site.</p>
  `, async () => {
    const title = $('#sl-title').value.trim();
    if (!title) { alert('Title required'); return false; }
    const created = await api('POST', '/api/slideshows', {
      kind, title,
      url: $('#sl-url').value.trim(),
      description: $('#sl-desc').value.trim(),
      event_id: $('#sl-event').value || null,
      competitive_event: $('#sl-comp') ? $('#sl-comp').value.trim() : null,
    });
    if (pendingCover) {
      try { await api('PUT', `/api/slideshows/${created.id}/cover`, { image: pendingCover }); }
      catch (e) { alert(`The resource was added, but the cover didn't upload: ${e.message} Use the Cover button to try again.`); }
    }
    await loadAll(); render();
    return true;
  });
  wireCoverInput();
}

// ---- Cover images ----
// An upload is shrunk in the browser (longest side 960px, JPEG) before it is
// sent, so a phone photo or a full-size screenshot stays small.
let pendingCover = null;
function coverFieldHtml(existingSrc) {
  pendingCover = null;
  return `
    <div class="form-row"><label>Cover image (optional)</label>
      <input id="sl-cover" type="file" accept="image/png,image/jpeg,image/webp" />
      <span class="hint" style="margin-top:4px;">A screenshot of the first slide or page works well. Without one, the site draws a plain cover.</span>
      <img id="sl-cover-preview" class="res-cover-preview ${existingSrc ? '' : 'hidden'}" src="${existingSrc || ''}" alt="Cover preview" />
    </div>`;
}
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error('Pick a PNG, JPEG, or WebP image.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image the browser can open.'));
      img.onload = () => {
        const scale = Math.min(1, 960 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function wireCoverInput() {
  const input = $('#sl-cover');
  if (!input) return;
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) { pendingCover = null; return; }
    try {
      pendingCover = await shrinkImage(file);
      const prev = $('#sl-cover-preview');
      prev.src = pendingCover;
      prev.classList.remove('hidden');
    } catch (e) {
      pendingCover = null;
      input.value = '';
      alert(e.message);
    }
  };
}
window.openCoverForm = function(id) {
  const s = (state.slideshows || []).find(x => x.id === id);
  if (!s) return;
  const src = s.has_cover ? `/api/slideshows/${s.id}/cover?v=${encodeURIComponent(s.cover_v || '')}` : '';
  showModal(`Cover for ${s.title}`, `
    ${coverFieldHtml(src)}
    ${s.has_cover ? `<p style="margin-top:6px;"><button class="btn small danger" type="button" onclick="removeCover(${s.id})">Remove cover</button></p>` : ''}
  `, async () => {
    if (!pendingCover) { alert('Pick an image first.'); return false; }
    await api('PUT', `/api/slideshows/${id}/cover`, { image: pendingCover });
    await loadAll(); render();
    return true;
  }, 'Save Cover');
  wireCoverInput();
};
window.removeCover = async function(id) {
  if (!confirm('Remove this cover? The site goes back to the plain drawn cover.')) return;
  await api('DELETE', `/api/slideshows/${id}/cover`);
  closeModal();
  await loadAll(); render();
};

async function deleteSlideshow(id) {
  if (!confirm('Delete this item?')) return;
  await api('DELETE', '/api/slideshows/' + id);
  await loadAll(); render();
}


