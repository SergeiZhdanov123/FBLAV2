// Event Sign-Up: members (no accounts) sign up for a competitive event, with
// their teammates, from the public hub. Officers set up the events and the
// chapter's registered FBLA member list in the officer portal.
//
// The rules this enforces, all on the server:
//   - Sign-ups only while an officer has them open (officers can always add).
//   - An event can't take more entries than the chapter is allowed.
//   - Team size has to be within the event's min/max.
//   - Each person can be in ONE individual/team event. FBLA also allows one
//     chapter project on top of that; officers can switch to "one event total".
//   - Once a member list exists, every name has to be on it.
//   - "Introduction to" events: 9th and 10th graders only (when the member
//     list has the person's grade).
//
// Double sign-ups and over-filled events are prevented in the database, not
// just checked first: every sign-up runs in a MongoDB transaction that locks
// the event, counts its entries, and claims each person under a unique key
// (signup_claims._id). Two people racing for the last spot, or the same person
// being signed up for two events at once, can't both succeed.
const db = require('./db');
const DEFAULT_EVENTS = require('./event-signup-defaults');

const C = { events: 'signup_events', signups: 'signups', claims: 'signup_claims', roster: 'member_roster' };
const SLOTS = ['main', 'chapter'];

class SignupError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

async function mdb() {
  await db.init();
  const a = db.ensureFirebase();
  return { d: a._db(), client: a._client() };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
// Comparison form: no accents, case, punctuation, or extra spaces.
// "José O'Brien-Smith " -> "jose obrien smith"
function normName(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Display form of a typed name, word by word: all-lowercase and ALL-CAPS
// words are capitalized ("jane DOE" -> "Jane Doe", "o'brien" -> "O'Brien");
// deliberate mixed case is kept ("McKenzie", "DeVries"); name particles stay
// lowercase after the first word ("Maria de la Cruz").
const PARTICLES = new Set(['de', 'la', 'del', 'della', 'da', 'di', 'du', 'van', 'von', 'der', 'den', 'le', 'y', 'bin', 'al']);
function tidyName(s) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  // Lowercase particles were typed on purpose unless the whole name is lowercase.
  const deliberate = clean !== clean.toLowerCase();
  return words.map((w, i) => {
    if (!w) return w;
    const lower = w.toLowerCase();
    if ((i > 0 || deliberate) && PARTICLES.has(lower) && w === lower) return w;
    if (w !== lower && w !== w.toUpperCase()) return w; // deliberate mixed case
    if (w === w.toUpperCase() && w.replace(/[^\p{L}]/gu, '').length <= 1) return w; // initials like "J."
    return lower.replace(/(^|['\u2019-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }).join(' ');
}
const fullName = (m) => `${m.first_name} ${m.last_name}`.replace(/\s+/g, ' ').trim();
const memberKey = (m) => normName(`${m.first_name} ${m.last_name}`);

// Work out who a typed name is.
//  - No member list yet: any first + last name, used as typed.
//  - With a member list, in order:
//      full name ("Jane Doe", "Doe, Jane", "Jane Marie Doe", preferred name + last)
//      first name + last initial ("Jane D")
//      first (or preferred) name alone, when exactly one member has it
//    Anything that matches more than one member, or nobody, is refused.
// Returns { ok, name, key, roster_id, grade } or { ok: false, error }.
function resolveName(input, roster) {
  const typed = normName(input);
  const shown = tidyName(input);
  if (!typed) return { ok: false, error: 'Enter a name.' };
  if (typed.length > 80) return { ok: false, error: 'That name is too long.' };
  const words = typed.split(' ');
  if (!roster || !roster.length) {
    if (words.length < 2) return { ok: false, error: 'Type a first and last name.' };
    return { ok: true, name: shown, key: typed, roster_id: null, grade: null };
  }
  const people = roster.map(m => ({ m, first: normName(m.first_name), last: normName(m.last_name), pref: normName(m.preferred_name) }));
  const isFirst = (p, w) => !!w && (w === p.first || w === p.pref || w === p.first.split(' ')[0]);
  let hits = people.filter(p => {
    if (typed === `${p.first} ${p.last}` || (p.pref && typed === `${p.pref} ${p.last}`) || typed === `${p.last} ${p.first}`) return true;
    // First name(s) then last name, with any middle names in between.
    const lastLen = p.last.split(' ').length;
    if (words.length > lastLen && words.slice(-lastLen).join(' ') === p.last) {
      const head = words.slice(0, words.length - lastLen);
      return head.join(' ') === p.first || isFirst(p, head[0]);
    }
    return false;
  });
  if (!hits.length && words.length === 2 && words[1].length === 1) hits = people.filter(p => isFirst(p, words[0]) && p.last.startsWith(words[1]));
  if (!hits.length) hits = people.filter(p => typed === p.first || (p.pref && typed === p.pref));
  if (!hits.length && words.length === 1) hits = people.filter(p => isFirst(p, words[0]));
  if (hits.length === 1) return rosterResult(hits[0].m, roster);
  if (hits.length > 1) {
    const oneName = new Set(hits.map(h => `${h.first} ${h.last}`)).size === 1;
    return { ok: false, error: oneName
      ? `More than one member is named ${fullName(hits[0].m)}. Ask an officer to sign you up.`
      : `More than one member matches "${shown}". Type the first and last name.` };
  }
  return { ok: false, error: `"${shown}" isn't on the chapter's FBLA member list. Check the spelling, or ask an officer.` };
}
function rosterResult(m, roster) {
  // Two members with the exact same name get separate keys.
  const key = memberKey(m);
  const twins = roster.filter(x => memberKey(x) === key).length > 1;
  return { ok: true, name: fullName(m), key: twins ? `${key}#${m.id}` : key, roster_id: m.id, grade: m.grade || null };
}

// ---------------------------------------------------------------------------
// Member list
// ---------------------------------------------------------------------------
const GRADE_WORDS = { freshman: '9', sophomore: '10', junior: '11', senior: '12' };
function cleanGrade(g) {
  const s = String(g == null ? '' : g).trim().toLowerCase();
  if (!s) return null;
  if (GRADE_WORDS[s]) return GRADE_WORDS[s];
  const n = parseInt(s, 10);
  return n >= 9 && n <= 12 ? String(n) : undefined; // undefined = invalid
}
function cleanMember(data) {
  const first = String(data.first_name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const last = String(data.last_name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const pref = String(data.preferred_name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!first || !last) throw new SignupError('First and last name are required.');
  const grade = cleanGrade(data.grade);
  if (grade === undefined) throw new SignupError(`Grade must be 9, 10, 11 or 12 (got "${data.grade}").`);
  return { first_name: tidyName(first), last_name: tidyName(last), preferred_name: pref ? tidyName(pref) : null, grade };
}

// Turn pasted text into member rows. Accepts:
//  - one name per line: "Jane Doe" (first word = first name) or "Doe, Jane"
//  - a spreadsheet paste/CSV WITH a header row naming the columns
//    (First Name, Last Name, and optionally Grade, Preferred Name)
//  - tab- or comma-separated rows without a header: First, Last, [Grade]
function parseRosterText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [], problems = [];
  if (!lines.length) return { rows, problems };
  const split = (line, delim) => {
    if (delim !== ',') return line.split(delim).map(s => s.trim());
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].split(',').length > 2 || /first|last/i.test(lines[0]) ? ',' : null);
  let header = null;
  if (delim) {
    const cells = split(lines[0], delim).map(c => c.toLowerCase());
    const find = (re) => cells.findIndex(c => re.test(c));
    const first = find(/first/), last = find(/last|surname/);
    if (first >= 0 && last >= 0) header = { first, last, grade: find(/grade|year|class/), pref: find(/prefer|nick/) };
  }
  lines.forEach((line, i) => {
    if (header && i === 0) return;
    let row;
    if (header) {
      const c = split(line, delim);
      row = { first_name: c[header.first], last_name: c[header.last], grade: header.grade >= 0 ? c[header.grade] : '', preferred_name: header.pref >= 0 ? c[header.pref] : '' };
    } else if (delim) {
      const c = split(line, delim);
      row = { first_name: c[0], last_name: c[1], grade: c[2] || '' };
    } else if (/^[^,]+,[^,]+$/.test(line)) {
      const [last, first] = line.split(',').map(s => s.trim()); // "Doe, Jane"
      row = { first_name: first, last_name: last };
    } else {
      const w = line.replace(/\s+/g, ' ').split(' ');
      row = { first_name: w[0], last_name: w.slice(1).join(' ') };
    }
    try { rows.push({ line: i + 1, ...cleanMember(row) }); }
    catch (e) { problems.push({ line: i + 1, text: line, error: e.message }); }
  });
  return { rows, problems };
}

async function listRoster() {
  const { d } = await mdb();
  const rows = await d.collection(C.roster).find({}).toArray();
  return rows.map(({ _id, ...r }) => r).sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
}
async function addRosterMembers(rows, byName) {
  const { d } = await mdb();
  const existing = new Set((await d.collection(C.roster).find({}, { projection: { key: 1 } }).toArray()).map(r => r.key));
  const toAdd = [], skipped = [];
  for (const r of rows) {
    const m = cleanMember(r);
    const key = memberKey(m);
    if (existing.has(key)) { skipped.push(fullName(m)); continue; }
    existing.add(key);
    toAdd.push({ ...m, key });
  }
  if (toAdd.length) {
    // nextId(name, n) reserves n ids and returns the LAST one.
    const firstId = await db.nextId('member_roster', toAdd.length) - toAdd.length + 1;
    const now = db.tsString();
    await d.collection(C.roster).insertMany(toAdd.map((m, i) => ({ _id: String(firstId + i), id: firstId + i, ...m, created_by: byName || null, created_at: now })));
  }
  return { added: toAdd.length, skipped };
}
async function updateRosterMember(id, data) {
  const { d } = await mdb();
  const m = cleanMember(data);
  const key = memberKey(m);
  const clash = await d.collection(C.roster).findOne({ key, id: { $ne: Number(id) } });
  if (clash) throw new SignupError(`${fullName(m)} is already on the list.`);
  const r = await d.collection(C.roster).findOneAndUpdate({ _id: String(Number(id)) }, { $set: { ...m, key } }, { returnDocument: 'after' });
  if (!r) throw new SignupError('That member is no longer on the list.', 404);
  return r;
}
async function deleteRosterMember(id) {
  const { d } = await mdb();
  const r = await d.collection(C.roster).findOneAndDelete({ _id: String(Number(id)) });
  if (!r) throw new SignupError('That member is no longer on the list.', 404);
  return r;
}
async function clearRoster() {
  const { d } = await mdb();
  const r = await d.collection(C.roster).deleteMany({});
  return r.deletedCount;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function intIn(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new SignupError(`${label} must be a whole number from ${lo} to ${hi}.`);
  return n;
}
function cleanEvent(data) {
  const name = String(data.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new SignupError('Event name is required.');
  const team = !!data.team;
  const min = team ? intIn(data.min_size, 1, 10, 'Smallest team size') : 1;
  const max = team ? intIn(data.max_size, 1, 10, 'Largest team size') : 1;
  if (max < min) throw new SignupError('The largest team size has to be at least the smallest.');
  return {
    name, team, min_size: min, max_size: max,
    max_entries: intIn(data.max_entries, 1, 50, team ? 'Number of teams' : 'Number of people'),
    chapter: !!data.chapter,
    grades: data.grades === '9-10' ? '9-10' : null,
  };
}
async function entryCounts(d) {
  const rows = await d.collection(C.signups).aggregate([{ $group: { _id: '$event_id', n: { $sum: 1 } } }]).toArray();
  return new Map(rows.map(r => [r._id, r.n]));
}
async function listEvents() {
  const { d } = await mdb();
  const [events, counts] = await Promise.all([d.collection(C.events).find({}).toArray(), entryCounts(d)]);
  return events.map(({ _id, lock, ...e }) => ({ ...e, taken: counts.get(e.id) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
async function addEvent(data) {
  const { d } = await mdb();
  const e = cleanEvent(data);
  const dupe = await d.collection(C.events).findOne({ name_lower: e.name.toLowerCase() });
  if (dupe) throw new SignupError(`${e.name} is already in the list.`);
  const id = await db.nextId('signup_events');
  const doc = { _id: String(id), id, ...e, name_lower: e.name.toLowerCase(), created_at: db.tsString() };
  await d.collection(C.events).insertOne(doc);
  return doc;
}
async function updateEvent(id, data) {
  const { d } = await mdb();
  const cur = await d.collection(C.events).findOne({ _id: String(Number(id)) });
  if (!cur) throw new SignupError('That event is no longer in the list.', 404);
  const e = cleanEvent(data);
  const dupe = await d.collection(C.events).findOne({ name_lower: e.name.toLowerCase(), id: { $ne: cur.id } });
  if (dupe) throw new SignupError(`${e.name} is already in the list.`);
  const entries = await d.collection(C.signups).find({ event_id: cur.id }).toArray();
  if (entries.length) {
    if (e.max_entries < entries.length) throw new SignupError(`${entries.length} ${entries.length === 1 ? 'entry is' : 'entries are'} already signed up, so the limit can't go below ${entries.length}.`);
    if (e.chapter !== !!cur.chapter) throw new SignupError('This event already has sign-ups. Remove them before changing whether it is a chapter project.');
    const bad = entries.find(s => s.people.length < e.min_size || s.people.length > e.max_size);
    if (bad || e.team !== !!cur.team) throw new SignupError(`A sign-up for this event has ${bad ? bad.people.length : 'a different number of'} people, which doesn't fit that team size. Change or remove it first.`);
  }
  await d.collection(C.events).updateOne({ _id: cur._id }, { $set: { ...e, name_lower: e.name.toLowerCase() } });
  if (e.name !== cur.name) await d.collection(C.signups).updateMany({ event_id: cur.id }, { $set: { event_name: e.name } });
  return { ...cur, ...e };
}
async function deleteEvent(id) {
  const { d } = await mdb();
  const n = await d.collection(C.signups).countDocuments({ event_id: Number(id) });
  if (n) throw new SignupError(`This event has ${n} sign-up${n === 1 ? '' : 's'}. Remove ${n === 1 ? 'it' : 'them'} first.`);
  const r = await d.collection(C.events).findOneAndDelete({ _id: String(Number(id)) });
  if (!r) throw new SignupError('That event is no longer in the list.', 404);
  return r;
}
// Add every 2026-27 PA FBLA event that isn't in the list yet (by name).
async function loadDefaultEvents() {
  const { d } = await mdb();
  const have = new Set((await d.collection(C.events).find({}, { projection: { name_lower: 1 } }).toArray()).map(e => e.name_lower));
  const missing = DEFAULT_EVENTS.filter(e => !have.has(e.name.toLowerCase()));
  if (missing.length) {
    const firstId = await db.nextId('signup_events', missing.length) - missing.length + 1;
    const now = db.tsString();
    await d.collection(C.events).insertMany(missing.map((e, i) => ({ _id: String(firstId + i), id: firstId + i, ...cleanEvent(e), name_lower: e.name.toLowerCase(), created_at: now })));
  }
  return { added: missing.length, already: DEFAULT_EVENTS.length - missing.length };
}

// ---------------------------------------------------------------------------
// Sign-ups
// ---------------------------------------------------------------------------
// The claim keys a sign-up holds. Normally a chapter project uses the
// "chapter" slot and everything else the "main" slot; in one-event-only mode
// every sign-up holds both, so a person can't be in two of anything.
const claimIds = (key, chapter, strict) => (strict ? SLOTS : [chapter ? 'chapter' : 'main']).map(s => `${s}|${key}`);

async function settingsFlags() {
  const s = await db.getSettings();
  const code = String(s.signup_code || '').trim();
  return {
    open: s.event_signup_open === '1', strict: s.signup_one_event_only === '1',
    // Officer-only: the public page is told only whether a code is needed.
    code_required: s.signup_code_required === '1' && !!code, code,
  };
}

// ---------------------------------------------------------------------------
// Sign-up code
// ---------------------------------------------------------------------------
// Officers can require a code (handed out at a meeting) before anyone can use
// the sign-up page, so people outside the chapter can't sign members up. The
// server checks it on every name check and sign-up, not just the page. Codes
// aren't case-sensitive and spaces don't matter ("fbla 2026" = "FBLA2026").
const normCode = (c) => String(c || '').toLowerCase().replace(/\s+/g, '');
async function setSignupCode({ required, code }) {
  const cur = await settingsFlags();
  let next = cur.code;
  if (code !== undefined) {
    next = String(code || '').replace(/\s+/g, ' ').trim();
    if (next && (normCode(next).length < 3 || next.length > 40)) throw new SignupError('The code has to be 3 to 40 characters.');
  }
  const on = required === undefined ? cur.code_required : !!required;
  if (on && !next) throw new SignupError('Type a code before turning it on.');
  await db.setSetting('signup_code', next);
  await db.setSetting('signup_code_required', on ? '1' : '0');
  return { code_required: on, code: next, changed: next !== cur.code };
}
// The claim (if any) someone already holds. `exceptSignupId`: ignore the
// claims of that sign-up (when an officer is editing it).
async function whoHas(d, ids, exceptSignupId = null) {
  const q = { _id: { $in: ids } };
  if (exceptSignupId != null) q.signup_id = { $ne: exceptSignupId };
  const claim = await d.collection(C.claims).findOne(q);
  return claim || null;
}
function alreadyMessage(claim) {
  return `${claim.name} is already signed up for ${claim.event_name}. Each person can only sign up once${claim._id.startsWith('chapter|') ? ' for a chapter project' : ''}. Ask an officer if this needs to change.`;
}

// Resolve every name for an event and check team size, duplicates and grade.
// Pure checks only; the database-level checks happen in createSignup.
// `edit` (officers changing a sign-up): { keep: its current people, signupId }.
// A name that's already on the sign-up is kept as it is (even if it isn't on
// the member list, e.g. added before the list existed); new names follow the
// usual rules, and the sign-up's own claims don't count as "already signed up".
async function prepare(ev, names, d, strict, edit = null) {
  const list = (Array.isArray(names) ? names : []).map(s => String(s || '').trim()).filter(Boolean);
  if (!list.length) throw new SignupError('Enter your name.', 400, { field: 0 });
  if (!ev.team && list.length > 1) throw new SignupError(`${ev.name} is an individual event. Sign up just one person.`);
  if (list.length > ev.max_size) throw new SignupError(`${ev.name} allows at most ${ev.max_size} people per team.`);
  if (list.length < ev.min_size) throw new SignupError(`${ev.name} needs at least ${ev.min_size} people per team.`);
  const roster = await d.collection(C.roster).find({}).toArray();
  const people = [];
  for (let i = 0; i < list.length; i++) {
    const kept = edit && (edit.keep || []).find(p => normName(p.name) === normName(list[i]));
    let r;
    if (kept) {
      const m = kept.roster_id ? roster.find(x => x.id === kept.roster_id) : null;
      r = { ok: true, name: kept.name, key: kept.key, roster_id: kept.roster_id || null, grade: m ? m.grade || null : null };
    } else r = resolveName(list[i], roster);
    if (!r.ok) throw new SignupError(r.error, 400, { field: i });
    if (people.some(p => p.key === r.key)) throw new SignupError(`${r.name} is listed more than once.`, 400, { field: i });
    if (ev.grades === '9-10' && r.grade && !['9', '10'].includes(String(r.grade))) {
      throw new SignupError(`${ev.name} is only for 9th and 10th graders, and ${r.name} is in ${r.grade}th grade.`, 400, { field: i });
    }
    people.push({ name: r.name, key: r.key, roster_id: r.roster_id });
  }
  const held = await whoHas(d, people.flatMap(p => claimIds(p.key, ev.chapter, strict)), edit ? edit.signupId : null);
  if (held) throw new SignupError(alreadyMessage(held), 409);
  return people;
}

// ---------------------------------------------------------------------------
// Short-lived caches for the public page
// ---------------------------------------------------------------------------
// Free Atlas (M0) runs 100 database operations a second and queues the rest,
// and the whole chapter opens the sign-up page at the same moment. The
// spots-left list and the member list are read far more often than they
// change, so each server instance reuses them briefly instead of re-reading
// them for every student. Everyone arriving together shares ONE read (the
// promise is cached), not one read each. Only the live-feedback paths
// (the event list and the name check) use these: createSignup always reads
// the database, and its transaction is what enforces open/closed, capacity
// and one event per person. Any officer change on this instance drops them
// at once (server.js); other instances catch up within the TTL.
const PUBLIC_STATE_TTL_MS = 2000;
const ROSTER_TTL_MS = 10000;
const caches = { state: null, roster: null, gate: null, who: null };
function cached(name, ttl, load) {
  const c = caches[name];
  if (c && Date.now() - c.at < ttl) return c.p;
  const p = load();
  caches[name] = { at: Date.now(), p };
  // A failed read isn't kept: the next request tries again.
  p.catch(() => { if (caches[name] && caches[name].p === p) caches[name] = null; });
  return p;
}
function dropCaches() { caches.state = null; caches.roster = null; caches.gate = null; caches.who = null; }
// Who signed up for what, for the public page: { eventId: [[names of one entry], ...] }
// in sign-up order. Names only. Shared and cached like the event list.
function publicEntries() {
  return cached('who', PUBLIC_STATE_TTL_MS, async () => {
    const { d } = await mdb();
    const rows = await d.collection(C.signups).find({}, { projection: { _id: 0, id: 1, event_id: 1, 'people.name': 1 } }).sort({ id: 1 }).toArray();
    const out = {};
    rows.forEach(s => { (out[s.event_id] = out[s.event_id] || []).push(s.people.map(p => p.name)); });
    return out;
  });
}
// Is this code good enough to use the sign-up page? (Always yes when no code
// is required.) Uses the short-lived settings copy, so checking it costs the
// database nothing.
async function codeAccepted(code) {
  const g = await cached('gate', PUBLIC_STATE_TTL_MS, async () => {
    const f = await settingsFlags();
    return { required: f.code_required, code: f.code };
  });
  return !g.required || normCode(code) === normCode(g.code);
}

// Check one typed name for the public form (live feedback before submitting).
async function checkName(name, eventId) {
  const { d } = await mdb();
  const roster = await cached('roster', ROSTER_TTL_MS, () => d.collection(C.roster).find({}).toArray());
  const r = resolveName(name, roster);
  if (!r.ok) return r;
  const st = await publicSignupState();
  const ev = eventId ? st.events.find(e => e.id === Number(eventId)) || null : null;
  const held = await whoHas(d, claimIds(r.key, ev ? ev.chapter : false, st.one_event_only));
  if (held) return { ok: false, name: r.name, error: alreadyMessage(held) };
  if (ev && ev.grades === '9-10' && r.grade && !['9', '10'].includes(String(r.grade))) {
    return { ok: false, name: r.name, error: `${ev.name} is only for 9th and 10th graders, and ${r.name} is in ${r.grade}th grade.` };
  }
  return { ok: true, name: r.name };
}

const fullError = (e) => new SignupError(`${e.name} is full (${e.max_entries} ${e.team ? (e.max_entries === 1 ? 'team' : 'teams') : (e.max_entries === 1 ? 'person' : 'people')}).`, 409, { full: true });
// Sign-ups for the same event take turns on this server instance. Without
// this, students racing for a popular event all start transactions on the same
// event document, collide, and retry over and over; on the free Atlas tier
// (100 operations a second) those retries were most of the load and pushed
// sign-ups to 20-60 seconds. Taking turns also keeps first come, first served
// within an instance. The transaction still guarantees the rules across
// instances; this only stops collisions.
const turns = new Map();
async function takeTurn(key, fn) {
  const before = turns.get(key) || Promise.resolve();
  const mine = before.then(fn);
  const done = mine.catch(() => {});
  turns.set(key, done);
  try { return await mine; } finally { if (turns.get(key) === done) turns.delete(key); }
}
async function createSignup({ eventId, names, source = 'member', byName = null }) {
  const { d, client } = await mdb();
  const { open, strict } = await settingsFlags();
  if (source === 'member' && !open) throw new SignupError('Event sign-up is closed right now.', 403);
  const ev = await d.collection(C.events).findOne({ _id: String(Number(eventId)) });
  if (!ev) throw new SignupError('That event is no longer available. Refresh the page.', 404);
  const people = await prepare(ev, names, d, strict);
  const doc = await takeTurn(ev.id, async () => {
    // Early exit for an event that's already full, so students still trying for
    // it don't each start a transaction that locks it (under load those lock
    // conflicts and retries were the main slowdown). The count is checked again
    // inside the transaction, which is what actually guarantees the limit.
    if (await d.collection(C.signups).countDocuments({ event_id: ev.id }) >= ev.max_entries) throw fullError(ev);
    const id = await db.nextId('signups');
    const doc = {
      _id: String(id), id, event_id: ev.id, event_name: ev.name, chapter: !!ev.chapter,
      people, source, submitted_by: source === 'officer' ? byName : people[0].name, created_at: db.tsString(),
    };
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        // Writing to the event document makes concurrent sign-ups for the same
        // event conflict, so the count below can't be stale when we commit.
        const fresh = await d.collection(C.events).findOneAndUpdate({ _id: ev._id }, { $inc: { lock: 1 } }, { session, returnDocument: 'after' });
        if (!fresh) throw new SignupError('That event is no longer available. Refresh the page.', 404);
        const taken = await d.collection(C.signups).countDocuments({ event_id: ev.id }, { session });
        if (taken >= fresh.max_entries) throw fullError(fresh);
        const claims = people.flatMap(p => claimIds(p.key, ev.chapter, strict).map(cid => ({ _id: cid, signup_id: id, event_id: ev.id, event_name: ev.name, name: p.name })));
        await d.collection(C.claims).insertMany(claims, { session, ordered: true });
        await d.collection(C.signups).insertOne(doc, { session });
      });
    } catch (e) {
      if (e instanceof SignupError) throw e;
      if (e && (e.code === 11000 || /E11000/.test(e.message || ''))) {
        const held = await whoHas(d, people.flatMap(p => claimIds(p.key, ev.chapter, strict)));
        throw new SignupError(held ? alreadyMessage(held) : 'Someone on this team just signed up for another event. Refresh and try again.', 409);
      }
      throw e;
    } finally {
      await session.endSession();
    }
    return doc;
  });
  const { _id, ...out } = doc;
  return out;
}

// Officers: change a sign-up's event and/or people (add a teammate, swap the
// event, fix a name). Same rules as a new sign-up (the event's limit, team
// size, one event per person, member list, grade), checked against everyone
// else. All in one transaction: the sign-up is either fully updated or left
// exactly as it was. Returns { before, after }.
async function updateSignup(id, { eventId, names, byName = null }) {
  const { d, client } = await mdb();
  const { strict } = await settingsFlags();
  const cur = await d.collection(C.signups).findOne({ _id: String(Number(id)) });
  if (!cur) throw new SignupError('That sign-up is gone. Refresh the page.', 404);
  const ev = await d.collection(C.events).findOne({ _id: String(Number(eventId == null || eventId === '' ? cur.event_id : eventId)) });
  if (!ev) throw new SignupError('That event is no longer available. Refresh the page.', 404);
  const people = await prepare(ev, names, d, strict, { keep: cur.people, signupId: cur.id });
  const moving = ev.id !== cur.event_id;
  const after = await takeTurn(ev.id, async () => {
    const session = client.startSession();
    let doc = null;
    try {
      await session.withTransaction(async () => {
        const now = await d.collection(C.signups).findOne({ _id: cur._id }, { session });
        if (!now) throw new SignupError('That sign-up is gone. Refresh the page.', 404);
        // Lock the event it's going to (as a new sign-up does), so the count can't go stale.
        const fresh = await d.collection(C.events).findOneAndUpdate({ _id: ev._id }, { $inc: { lock: 1 } }, { session, returnDocument: 'after' });
        if (!fresh) throw new SignupError('That event is no longer available. Refresh the page.', 404);
        if (ev.id !== now.event_id) {
          const taken = await d.collection(C.signups).countDocuments({ event_id: ev.id }, { session });
          if (taken >= fresh.max_entries) throw fullError(fresh);
          await d.collection(C.events).updateOne({ id: now.event_id }, { $inc: { lock: 1 } }, { session });
        }
        // Swap this sign-up's claims for the new ones; a person someone else
        // already holds fails the insert (unique _id) and nothing is changed.
        await d.collection(C.claims).deleteMany({ signup_id: now.id }, { session });
        const claims = people.flatMap(p => claimIds(p.key, ev.chapter, strict).map(cid => ({ _id: cid, signup_id: now.id, event_id: ev.id, event_name: ev.name, name: p.name })));
        await d.collection(C.claims).insertMany(claims, { session, ordered: true });
        const set = { event_id: ev.id, event_name: ev.name, chapter: !!ev.chapter, people, updated_at: db.tsString(), updated_by: byName };
        await d.collection(C.signups).updateOne({ _id: now._id }, { $set: set }, { session });
        doc = { ...now, ...set };
      });
    } catch (e) {
      if (e instanceof SignupError) throw e;
      if (e && (e.code === 11000 || /E11000/.test(e.message || ''))) {
        const held = await whoHas(d, people.flatMap(p => claimIds(p.key, ev.chapter, strict)), cur.id);
        throw new SignupError(held ? alreadyMessage(held) : 'Someone on this team just signed up for another event. Refresh and try again.', 409);
      }
      throw e;
    } finally {
      await session.endSession();
    }
    return doc;
  });
  const strip = ({ _id, ...x }) => x;
  return { before: strip(cur), after: strip(after), moved: moving };
}

async function deleteSignup(id) {
  const { d, client } = await mdb();
  const session = client.startSession();
  let removed = null;
  try {
    await session.withTransaction(async () => {
      removed = await d.collection(C.signups).findOneAndDelete({ _id: String(Number(id)) }, { session });
      if (!removed) throw new SignupError('That sign-up is already gone.', 404);
      await d.collection(C.claims).deleteMany({ signup_id: removed.id }, { session });
      await d.collection(C.events).updateOne({ id: removed.event_id }, { $inc: { lock: 1 } }, { session });
    });
  } finally { await session.endSession(); }
  return removed;
}

async function listSignups() {
  const { d } = await mdb();
  const [signups, roster] = await Promise.all([d.collection(C.signups).find({}).sort({ id: 1 }).toArray(), d.collection(C.roster).find({}).toArray()]);
  const keys = new Set();
  roster.forEach(m => { keys.add(memberKey(m)); keys.add(`${memberKey(m)}#${m.id}`); });
  return signups.map(({ _id, ...s }) => ({
    ...s,
    people: s.people.map(p => ({ ...p, on_roster: roster.length ? keys.has(p.key) : null })),
  }));
}

// Switch between "one event + one chapter project" (FBLA's rule) and "one
// event total". Rebuilds every claim for the new rule in one transaction; if
// someone already holds two sign-ups, one-event-only is refused.
async function setOneEventOnly(strict) {
  const { d, client } = await mdb();
  const signups = await d.collection(C.signups).find({}).toArray();
  if (strict) {
    const seen = new Map();
    for (const s of signups) for (const p of s.people) {
      if (seen.has(p.key)) throw new SignupError(`${p.name} is signed up for both ${seen.get(p.key)} and ${s.event_name}. Remove one before switching to one event total.`);
      seen.set(p.key, s.event_name);
    }
  }
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await d.collection(C.claims).deleteMany({}, { session });
      const claims = signups.flatMap(s => s.people.flatMap(p => claimIds(p.key, s.chapter, strict).map(cid => ({ _id: cid, signup_id: s.id, event_id: s.event_id, event_name: s.event_name, name: p.name }))));
      if (claims.length) await d.collection(C.claims).insertMany(claims, { session, ordered: true });
      await d.collection('settings').updateOne({ _id: 'signup_one_event_only' }, { $set: { key: 'signup_one_event_only', value: strict ? '1' : '0' } }, { upsert: true, session });
    });
  } finally { await session.endSession(); }
}

// What the public page needs: the events and how full they are. No names.
// Cached briefly (see "Short-lived caches" above); callers must not modify it.
function publicSignupState() {
  return cached('state', PUBLIC_STATE_TTL_MS, async () => {
    const { d } = await mdb();
    const { open, strict, code_required } = await settingsFlags();
    const [events, rosterCount] = await Promise.all([listEvents(), d.collection(C.roster).countDocuments({})]);
    return {
      open, one_event_only: strict, member_list: rosterCount > 0, code_required,
      events: events.map(e => ({ id: e.id, name: e.name, team: e.team, min_size: e.min_size, max_size: e.max_size, max_entries: e.max_entries, taken: e.taken, chapter: e.chapter, grades: e.grades })),
    };
  });
}

// ---------------------------------------------------------------------------
// Export (officers): every event and who signed up, as CSV or an Excel file.
// ---------------------------------------------------------------------------
const typeText = (e) => (e.chapter ? 'Chapter project' : e.team ? 'Team' : 'Individual');
const sizeText = (e) => (e.team ? (e.min_size === e.max_size ? `${e.max_size}` : `${e.min_size}-${e.max_size}`) : '1');
async function exportData() {
  const [events, signups, roster] = await Promise.all([listEvents(), listSignups(), listRoster()]);
  const byEvent = new Map(events.map(e => [e.id, []]));
  for (const s of signups) { if (!byEvent.has(s.event_id)) byEvent.set(s.event_id, []); byEvent.get(s.event_id).push(s); }
  const maxPeople = Math.max(1, ...events.map(e => e.max_size), ...signups.map(s => s.people.length));
  const offList = (s) => s.people.filter(p => p.on_roster === false).map(p => p.name).join('; ');
  // One row per entry; events nobody has signed up for still get a row.
  const byEventRows = [];
  for (const e of events) {
    const entries = byEvent.get(e.id) || [];
    const base = [e.name, typeText(e), sizeText(e), e.max_entries, entries.length, Math.max(0, e.max_entries - entries.length)];
    if (!entries.length) byEventRows.push([...base, '', ...Array(maxPeople).fill(''), '']);
    entries.forEach((s, i) => byEventRows.push([...base, i + 1, ...Array.from({ length: maxPeople }, (_, k) => (s.people[k] ? s.people[k].name : '')), offList(s)]));
  }
  const byEventHead = ['Event', 'Type', 'People per entry', 'Allowed', 'Signed up', 'Spots left', 'Entry #', ...Array.from({ length: maxPeople }, (_, k) => `Person ${k + 1}`), 'Not on member list'];
  const gradeOf = new Map(roster.map(m => [m.id, m.grade || '']));
  const people = signups.flatMap(s => s.people.map(p => [p.name, s.event_name, s.chapter ? 'Chapter project' : (s.people.length > 1 || (events.find(e => e.id === s.event_id) || {}).team ? 'Team' : 'Individual'),
    s.people.filter(x => x !== p).map(x => x.name).join(', '), p.roster_id ? gradeOf.get(p.roster_id) || '' : '', p.on_roster === null ? '' : p.on_roster ? 'Yes' : 'No']))
    .sort((a, b) => a[0].localeCompare(b[0]));
  const signedIds = new Set(signups.flatMap(s => s.people.map(p => p.roster_id).filter(Boolean)));
  const notSigned = roster.filter(m => !signedIds.has(m.id)).map(m => [m.last_name, m.first_name, m.preferred_name || '', m.grade || '']);
  const entryRows = [...signups].sort((a, b) => a.event_name.localeCompare(b.event_name) || a.id - b.id)
    .map(s => [s.event_name, s.people.map(p => p.name).join(', '), s.people.length, s.source === 'officer' ? `Officer: ${s.submitted_by || ''}` : 'Member, on the site', s.created_at || '', offList(s)]);
  return {
    byEvent: { head: byEventHead, rows: byEventRows },
    entries: { head: ['Event', 'People', 'Team size', 'Signed up by', 'Signed up at', 'Not on member list'], rows: entryRows },
    people: { head: ['Name', 'Event', 'Type', 'Teammates', 'Grade', 'On member list'], rows: people },
    notSigned: roster.length ? { head: ['Last name', 'First name', 'Preferred name', 'Grade'], rows: notSigned } : null,
  };
}
function toCsv(table) {
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  return [table.head, ...table.rows].map(r => r.map(q).join(',')).join('\r\n');
}
async function signupsCsv() {
  return toCsv((await exportData()).byEvent);
}
async function signupsXlsx() {
  const ExcelJS = require('exceljs');
  const data = await exportData();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'State High FBLA';
  wb.created = new Date();
  const sheet = (name, table, widths) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(table.head);
    table.rows.forEach(r => ws.addRow(r));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12336D' } };
    head.alignment = { vertical: 'middle' };
    ws.columns.forEach((c, i) => {
      const longest = Math.max(...[table.head, ...table.rows].map(r => String(r[i] == null ? '' : r[i]).length));
      c.width = Math.min(widths || 48, Math.max(8, longest + 2));
    });
    if (table.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.head.length } };
    return ws;
  };
  const ev = sheet('By event', data.byEvent);
  // Shade full events and flag names not on the member list.
  ev.eachRow((row, n) => {
    if (n === 1) return;
    if (row.getCell(6).value === 0) row.getCell(6).font = { bold: true, color: { argb: 'FFB91C1C' } };
    const flag = row.getCell(data.byEvent.head.length);
    if (flag.value) flag.font = { color: { argb: 'FFB91C1C' } };
  });
  sheet('Sign-ups', data.entries);
  sheet('People', data.people);
  if (data.notSigned) sheet('Not signed up yet', data.notSigned);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Officer changes drop the public caches when they finish, even if they fail
// partway, so the page and name check never keep stale rules on this instance.
const dropping = (fn) => async (...args) => { try { return await fn(...args); } finally { dropCaches(); } };
module.exports = {
  SignupError, normName, tidyName, resolveName, parseRosterText, cleanEvent, cleanMember,
  listRoster, addRosterMembers: dropping(addRosterMembers), updateRosterMember: dropping(updateRosterMember),
  deleteRosterMember: dropping(deleteRosterMember), clearRoster: dropping(clearRoster),
  listEvents, addEvent: dropping(addEvent), updateEvent: dropping(updateEvent), deleteEvent: dropping(deleteEvent),
  loadDefaultEvents: dropping(loadDefaultEvents),
  checkName, createSignup, updateSignup: dropping(updateSignup), deleteSignup: dropping(deleteSignup), listSignups, setOneEventOnly: dropping(setOneEventOnly), settingsFlags,
  setSignupCode: dropping(setSignupCode), codeAccepted, publicEntries,
  publicSignupState, dropCaches, exportData, signupsCsv, signupsXlsx, DEFAULT_EVENTS, COLLECTIONS: C,
};
