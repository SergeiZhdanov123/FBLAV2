// Member points straight from the chapter's Google Sheet ("FBLA Point System +
// Attendance Master", Points tab). Officers paste the sheet link in the Points
// tab and share the sheet (Viewer) with the site's service account. The site
// then reads the sheet at most every 10 minutes, when someone opens the hub or
// looks up their points, and updates member points and the public top 10.
//
// Read-only: the site never writes to the sheet. A sheet that looks wrong
// (columns missing, far fewer names, mostly unknown names) changes nothing.
const { GoogleAuth } = require('google-auth-library');
const { loadCredentials, parseSpreadsheetId } = require('./google-sheets-backup');

const INTERVAL_MS = 10 * 60 * 1000;
const MIN_ROWS = 10;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const CONFIG_KEY = 'points_sheet';
const STATUS_KEY = 'points_sheet_status';

class SheetError extends Error {}

function parseJson(v, fallback) {
  if (v && typeof v === 'object') return v;
  try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function cleanConfig(v) {
  const c = parseJson(v, {});
  const id = parseSpreadsheetId(c.sheet_id || c.url || '');
  return {
    sheet_id: /^[a-zA-Z0-9_-]{20,}$/.test(id) ? id : '',
    tab: String(c.tab || 'Points').replace(/[\u0000-\u001f']/g, '').trim().slice(0, 100) || 'Points',
    enabled: !!c.enabled,
  };
}

// Sheet rows -> [{ name, total }]. Uses the FIRST "Member Name" column and the
// first "Total Points" column after it (the tab also has a sorted copy on the
// right). A blank or "-" total is 0.
function parsePointsRows(values) {
  const rows = Array.isArray(values) ? values : [];
  const cell = (v) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
  let head = -1, nameCol = -1, totalCol = -1;
  for (let i = 0; i < Math.min(rows.length, 10) && head < 0; i++) {
    const r = (rows[i] || []).map(c => cell(c).toLowerCase());
    const n = r.indexOf('member name');
    const t = n < 0 ? -1 : r.findIndex((c, j) => j > n && c === 'total points');
    if (n >= 0 && t > n) { head = i; nameCol = n; totalCol = t; }
  }
  if (head < 0) throw new SheetError('Could not find the "Member Name" and "Total Points" columns in that tab.');
  const out = [], problems = [];
  for (const r of rows.slice(head + 1)) {
    const name = cell((r || [])[nameCol]);
    if (!name) continue;
    const raw = cell((r || [])[totalCol]).replace(/,/g, '');
    let total;
    if (raw === '' || raw === '-') total = 0;
    else if (/^\d+(\.\d+)?$/.test(raw)) total = Math.round(Number(raw));
    else { problems.push(`${name}: "${raw}" isn't a number`); continue; }
    if (total > 1000000) { problems.push(`${name}: ${total} is too big`); continue; }
    out.push({ name: name.slice(0, 120), total });
  }
  return { rows: out, problems };
}

// Match sheet names to the member list. Exact full name first (first or
// preferred name + last name, ignoring case/accents/punctuation). A name with
// no exact match falls back to first word of the first name + last word of the
// last name, only when that points to exactly one member. A member with no
// sheet row of their own whose short name matches exactly one matched row
// (a second entry like "Sophia Kantor" for "Sophia Maria Kantor") follows it.
function matchRoster(sheetRows, roster, normName) {
  const fullKeys = (m) => {
    const last = normName(m.last_name);
    return [`${normName(m.first_name)} ${last}`, m.preferred_name ? `${normName(m.preferred_name)} ${last}` : null].filter(Boolean);
  };
  const shortKey = (first, last) => `${normName(first).split(' ')[0]} ${normName(last).split(' ').pop()}`;
  const shortOfName = (n) => { const w = normName(n).split(' '); return `${w[0]} ${w[w.length - 1]}`; };
  const byFull = new Map(), byShort = new Map();
  const add = (map, k, m) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(m); };
  for (const m of roster) {
    fullKeys(m).forEach(k => add(byFull, k, m));
    add(byShort, shortKey(m.first_name, m.last_name), m);
    if (m.preferred_name) add(byShort, shortKey(m.preferred_name, m.last_name), m);
  }
  // The same name twice in the sheet with different totals: skip it.
  const seen = new Map(), conflicted = new Set();
  for (const r of sheetRows) {
    const k = normName(r.name);
    if (seen.has(k) && seen.get(k) !== r.total) conflicted.add(k);
    seen.set(k, r.total);
  }
  const assigned = new Map(); // member id -> total
  const unmatched = [], ambiguous = [], conflicts = [], matchedRows = [];
  for (const r of sheetRows) {
    const k = normName(r.name);
    if (conflicted.has(k)) { if (!conflicts.includes(r.name)) conflicts.push(r.name); continue; }
    let hits = [...(byFull.get(k) || [])];
    if (!hits.length) hits = k.split(' ').length >= 2 ? [...(byShort.get(shortOfName(r.name)) || [])] : [];
    if (!hits.length) { unmatched.push(r.name); continue; }
    if (hits.length > 1) { ambiguous.push(r.name); continue; }
    assigned.set(hits[0].id, r.total);
    matchedRows.push({ row: r, member: hits[0] });
  }
  for (const m of roster) {
    if (assigned.has(m.id)) continue;
    const sk = shortKey(m.first_name, m.last_name);
    const rows = matchedRows.filter(x => shortKey(x.member.first_name, x.member.last_name) === sk);
    if (rows.length === 1) assigned.set(m.id, rows[0].row.total);
  }
  return { assigned, unmatched, ambiguous, conflicts, matched: matchedRows.length };
}

// Top 10 for the public board, the way the lookup ranks people: officers left
// out, and two entries for the same person (same first word, last word and
// points) shown once.
function topTen(roster, officers, normName) {
  const isOfficer = (m) => {
    const last = normName(m.last_name);
    return !!officers && [`${normName(m.first_name)} ${last}`, m.preferred_name ? `${normName(m.preferred_name)} ${last}` : null].some(k => k && officers.has(k));
  };
  const seen = new Set();
  return roster.filter(m => typeof m.points === 'number' && !isOfficer(m))
    .sort((a, b) => b.points - a.points || a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
    .filter(m => {
      const k = `${normName(m.first_name).split(' ')[0]} ${normName(m.last_name).split(' ').pop()}|${m.points}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 10).map(m => ({ name: `${m.first_name} ${m.last_name}`.replace(/\s+/g, ' ').trim().slice(0, 60), points: m.points }));
}

async function readSheet(config, env = process.env) {
  const credentials = loadCredentials(env);
  if (!credentials) throw new SheetError('The site has no Google service account set up.');
  const auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
  const client = await auth.getClient();
  const range = `'${config.tab}'!A1:Z3000`;
  try {
    const r = await client.request({
      url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheet_id)}/values/${encodeURIComponent(range)}`,
      params: { valueRenderOption: 'UNFORMATTED_VALUE' },
      timeout: 8000,
    });
    return r.data.values || [];
  } catch (e) {
    const code = e.response && e.response.status;
    if (code === 403 || code === 404) throw new SheetError(`The site can't open that sheet. Share it (Viewer) with ${credentials.client_email}.`);
    if (code === 400) throw new SheetError(`There's no tab called "${config.tab}" in that sheet.`);
    throw new SheetError(`Google Sheets didn't answer (${code || e.message}). The site will try again in 10 minutes.`);
  }
}

// deps: { db, signup, officerNames: async () => Set, fetchRows?: async (config) => values, now?: () => Date }
function createPointsSync(deps) {
  const { db, signup } = deps;
  const fetchRows = deps.fetchRows || ((c) => readSheet(c));
  const now = deps.now || (() => new Date());
  let lastTry = 0;
  let running = null;

  async function saveStatus(status) {
    await db.setSetting(STATUS_KEY, JSON.stringify(status));
  }

  async function runOnce(reason) {
    const settings = await db.getSettings();
    const config = cleanConfig(settings[CONFIG_KEY]);
    if (!config.sheet_id) throw new SheetError('No sheet link is saved.');
    const prev = parseJson(settings[STATUS_KEY], {});
    const checkedAt = now().toISOString();
    try {
      const { rows, problems } = parsePointsRows(await fetchRows(config));
      if (rows.length < MIN_ROWS) throw new SheetError(`Only ${rows.length} names in the sheet. That looks wrong, so nothing was changed.`);
      const roster = await signup.listRoster();
      const m = matchRoster(rows, roster, signup.normName);
      if (m.matched < rows.length / 2) throw new SheetError(`Only ${m.matched} of ${rows.length} names in the sheet are on the member list. That looks like the wrong sheet or tab, so nothing was changed.`);
      const updates = roster.filter(r => m.assigned.has(r.id) && r.points !== m.assigned.get(r.id))
        .map(r => ({ id: r.id, points: m.assigned.get(r.id) }));
      if (updates.length) await signup.setRosterPoints(updates);
      const after = roster.map(r => (m.assigned.has(r.id) ? { ...r, points: m.assigned.get(r.id) } : r));
      const board = topTen(after, await deps.officerNames(), signup.normName);
      const page = db.pointsPage(settings.points_page);
      const boardChanged = JSON.stringify(board) !== JSON.stringify(page.leaderboard);
      if (updates.length || boardChanged) {
        const today = now().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        await db.setSetting('points_page', JSON.stringify({ ...db.pointsPage({ ...page, leaderboard: board }), updated_at: today }));
        await db.logAudit('Google Sheet sync', 'roster_points', `Points from the Google Sheet (${reason}): ${updates.length} member${updates.length === 1 ? '' : 's'} updated${boardChanged ? ', top 10 refreshed' : ''}`);
      }
      const status = {
        ok: true, error: '', checked_at: checkedAt,
        changed_at: updates.length || boardChanged ? checkedAt : (prev.changed_at || ''),
        last_updated: updates.length, sheet_names: rows.length, matched: m.matched,
        unmatched: m.unmatched.slice(0, 50), ambiguous: m.ambiguous.slice(0, 50),
        problems: [...m.conflicts.map(n => `${n}: listed twice with different totals`), ...problems].slice(0, 50),
      };
      await saveStatus(status);
      return { ...status, changed: updates.length > 0 || boardChanged };
    } catch (e) {
      const status = { ...prev, ok: false, error: e instanceof SheetError ? e.message : `Sync failed: ${e.message}`, checked_at: checkedAt };
      try { await saveStatus(status); } catch (e2) { /* keep the first error */ }
      if (!(e instanceof SheetError)) console.error('points sheet sync failed:', e);
      return { ...status, changed: false };
    }
  }

  function run(reason) {
    if (!running) running = runOnce(reason).finally(() => { running = null; });
    return running;
  }

  // Called on public page loads. Cheap when not due: no database read at all
  // until 10 minutes have passed on this instance.
  async function maybeSync() {
    if (Date.now() - lastTry < INTERVAL_MS) return { changed: false, skipped: true };
    lastTry = Date.now();
    const settings = await db.getSettings();
    const config = cleanConfig(settings[CONFIG_KEY]);
    if (!config.enabled || !config.sheet_id) return { changed: false, skipped: true };
    const status = parseJson(settings[STATUS_KEY], {});
    const last = Date.parse(status.checked_at || '') || 0;
    if (Date.now() - last < INTERVAL_MS) { lastTry = last; return { changed: false, skipped: true }; }
    return run('automatic');
  }

  async function getState() {
    const s = await db.getSettings();
    let email = '';
    try { email = (loadCredentials() || {}).client_email || ''; } catch (e) { email = ''; }
    return { ...cleanConfig(s[CONFIG_KEY]), status: parseJson(s[STATUS_KEY], null), service_email: email };
  }

  async function saveConfig(input) {
    const c = cleanConfig(input);
    if ((input.url || input.sheet_id) && !c.sheet_id) throw new SheetError("That doesn't look like a Google Sheets link.");
    if (c.enabled && !c.sheet_id) throw new SheetError('Paste the sheet link first.');
    await db.setSetting(CONFIG_KEY, JSON.stringify(c));
    lastTry = 0;
    return c;
  }

  return { maybeSync, syncNow: (reason) => { lastTry = Date.now(); return run(reason || 'Sync now'); }, getState, saveConfig };
}

module.exports = { createPointsSync, parsePointsRows, matchRoster, topTen, cleanConfig, SheetError, INTERVAL_MS };
