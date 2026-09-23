// ============================================================
// MongoDB data layer (exposed through a Firestore-compatible adapter)
//
// Data lives in MongoDB (Atlas). The business logic below was written against
// the Firebase Admin SDK, so a thin adapter (further down) implements the small
// slice of the Firestore API it uses on top of the `mongodb` driver. Every
// exported function keeps the same name, arguments, and return shape, so
// server.js and the frontend (public/app.js) work without changes.
//
// FBLAappV2 keeps NO student accounts or student records. The only accounts
// are officer accounts; everything members see is public chapter information
// (calendar, announcements, resources, Google Form links). There is no members
// collection, and nothing here stores a student's name, email, dues, or points.
//
// Design notes for a single-chapter dataset (hundreds of transactions):
//   - Numeric auto-increment ids are preserved (the frontend depends on them)
//     via a `counters` collection and an atomic $inc in nextId().
//   - The few "joined" reads (transaction -> event name, etc.) load the
//     related collection and join in JS.
//   - Sorting/grouping is done in JS, so no special indexes are required.
//   - Multi-document writes are committed atomically (batches use a Mongo
//     transaction when they span more than one collection).
// ============================================================
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// ============================================================
// MongoDB data layer, exposed through a thin Firestore-compatible adapter.
//
// The rest of this file was written against the Firebase Admin SDK. Rather than
// touch ~3,000 lines of business logic, we implement the small slice of the
// Firestore API it actually uses (collection/doc/where/get/set/update/delete,
// batches, and transactions) on top of the official `mongodb` driver.
//
// Faithful-semantics notes:
//   - A document's Firestore id maps to Mongo `_id` as a STRING (String(id)),
//     preserving numeric-id, composite-key, and settings-key collections alike.
//   - data() returns the stored fields with `_id` stripped (Firestore's data()
//     excludes the doc id); the numeric `id` field is kept as-is.
//   - Transactions buffer writes and apply them at the end within one Mongo
//     transaction, mirroring Firestore's "reads first, writes committed
//     atomically" model, so unawaited t.set()/t.update()/t.delete() behave the
//     same as before.
//   - `ignoreUndefined` on the client mirrors ignoreUndefinedProperties.
// ============================================================
const MONGO_URI = process.env.MONGODB_URI;
// Defaults to its own database, NOT V1's `fbla`, so a missing env var can never
// point V2 at the live chapter records.
const MONGO_DBNAME = process.env.MONGODB_DB || 'fbla_v2';

let mongoClient = null;
let mongoDb = null;
let adapter = null;
// `db` is the adapter handle the business logic below calls directly
// (db.batch(), db.runTransaction()); set in ensureFirebase().
let db = null;

function stripId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

function makeDocSnapshot(ref, doc) {
  return { exists: !!doc, id: ref.id, ref, data: () => (doc ? stripId(doc) : undefined) };
}

function makeDocRef(name, idStr) {
  const ref = {
    id: idStr,
    _name: name,
    get: async (opts) => {
      const doc = await mongoDb.collection(name).findOne({ _id: idStr }, { session: opts && opts.session });
      return makeDocSnapshot(ref, doc);
    },
    set: async (data, options) => {
      const coll = mongoDb.collection(name);
      if (options && options.merge) {
        await coll.updateOne({ _id: idStr }, { $set: { ...data, _id: idStr } }, { upsert: true });
      } else {
        await coll.replaceOne({ _id: idStr }, { ...data, _id: idStr }, { upsert: true });
      }
    },
    update: async (data) => {
      // Firestore's update() rejects if the document doesn't exist; Mongo's
      // updateOne() silently no-ops (matchedCount 0). Mirror Firestore so a stale
      // id surfaces as an error instead of a silent data loss.
      const r = await mongoDb.collection(name).updateOne({ _id: idStr }, { $set: data });
      if (r.matchedCount === 0) throw new Error(`No document to update: ${name}/${idStr}`);
    },
    delete: async () => { await mongoDb.collection(name).deleteOne({ _id: idStr }); },
  };
  return ref;
}

// Only '==' and 'array-contains' are used; both map to a plain equality match
// in Mongo (array-contains because Mongo matches a scalar against array members).
function whereFilter(field, op, value) {
  switch (op) {
    case '==': case 'array-contains': return { [field]: value };
    case '!=': return { [field]: { $ne: value } };
    case '>': return { [field]: { $gt: value } };
    case '>=': return { [field]: { $gte: value } };
    case '<': return { [field]: { $lt: value } };
    case '<=': return { [field]: { $lte: value } };
    case 'in': return { [field]: { $in: value } };
    default: throw new Error('Unsupported query operator: ' + op);
  }
}

// Run a find and shape it like a Firestore QuerySnapshot. Session is passed
// when the read happens inside a transaction.
async function runFind(name, filter, limitN, session) {
  let cursor = mongoDb.collection(name).find(filter || {}, session ? { session } : undefined);
  if (limitN) cursor = cursor.limit(limitN);
  const arr = await cursor.toArray();
  const docs = arr.map(doc => ({ id: String(doc._id), ref: makeDocRef(name, String(doc._id)), data: () => stripId(doc) }));
  return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
}

// Query/collection objects carry `_isQuery` so a transaction's t.get() can tell
// a collection/query read (returns a QuerySnapshot) from a doc-ref read.
function makeQuery(name, filter, limitN) {
  return {
    _isQuery: true, _name: name, _filter: filter, _limit: limitN,
    where: (field, op, value) => makeQuery(name, { ...filter, ...whereFilter(field, op, value) }, limitN),
    limit: (n) => makeQuery(name, filter, n),
    get: () => runFind(name, filter, limitN),
  };
}

function makeCollection(name) {
  return {
    _isQuery: true, _name: name, _filter: {}, _limit: 0,
    doc: (id) => makeDocRef(name, String(id)),
    where: (field, op, value) => makeQuery(name, whereFilter(field, op, value), 0),
    limit: (n) => makeQuery(name, {}, n),
    get: () => runFind(name, {}, 0),
  };
}

function makeBatch() {
  const byColl = new Map();
  const push = (name, op) => { if (!byColl.has(name)) byColl.set(name, []); byColl.get(name).push(op); };
  return {
    set: (ref, data, options) => {
      if (options && options.merge) push(ref._name, { updateOne: { filter: { _id: ref.id }, update: { $set: { ...data, _id: ref.id } }, upsert: true } });
      else push(ref._name, { replaceOne: { filter: { _id: ref.id }, replacement: { ...data, _id: ref.id }, upsert: true } });
    },
    update: (ref, data) => push(ref._name, { updateOne: { filter: { _id: ref.id }, update: { $set: data } } }),
    delete: (ref) => push(ref._name, { deleteOne: { filter: { _id: ref.id } } }),
    // Firestore WriteBatch is all-or-nothing. MongoDB bulkWrite() is NOT atomic
    // across documents (a single collection with many ops can partially apply),
    // so the only way to match Firestore is a transaction. A batch with a single
    // write can't partially apply, so it goes direct; anything larger (multiple
    // docs and/or multiple collections) runs inside one Mongo transaction so all
    // writes land together or not at all.
    commit: async () => {
      if (byColl.size === 0) return;
      const totalWrites = [...byColl.values()].reduce((n, w) => n + w.length, 0);
      if (totalWrites <= 1) {
        const [[name, writes]] = byColl;
        await mongoDb.collection(name).bulkWrite(writes, { ordered: true });
        return;
      }
      const session = mongoClient.startSession();
      try {
        await session.withTransaction(async () => {
          for (const [name, writes] of byColl) await mongoDb.collection(name).bulkWrite(writes, { ordered: true, session });
        });
      } finally {
        await session.endSession();
      }
    },
  };
}

// Firestore-style transaction: reads run immediately (with the session), writes
// are buffered and flushed atomically at the end inside one Mongo transaction.
//
// Firestore allows concurrent reads in a transaction (e.g. Promise.all of
// several t.get()); MongoDB forbids concurrent operations on one session. So we
// SERIALIZE every in-transaction operation on an internal chain: even if the
// caller fires them concurrently, they execute one at a time on the session.
async function runTransaction(fn) {
  const session = mongoClient.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      let chain = Promise.resolve();
      const serialize = (op) => { const p = chain.then(op); chain = p.then(() => {}, () => {}); return p; };
      const writes = [];
      const exec = (kind, ref, data, options) => serialize(() => {
        const coll = mongoDb.collection(ref._name);
        if (kind === 'set') return (options && options.merge)
          ? coll.updateOne({ _id: ref.id }, { $set: { ...data, _id: ref.id } }, { upsert: true, session })
          : coll.replaceOne({ _id: ref.id }, { ...data, _id: ref.id }, { upsert: true, session });
        if (kind === 'update') return coll.updateOne({ _id: ref.id }, { $set: data }, { session })
          .then(r => { if (r.matchedCount === 0) throw new Error(`No document to update: ${ref._name}/${ref.id}`); return r; });
        return coll.deleteOne({ _id: ref.id }, { session });
      });
      const t = {
        // Firestore's t.get() accepts a DocumentReference OR a Query/Collection.
        get: (target) => serialize(async () => {
          if (target && target._isQuery) return runFind(target._name, target._filter, target._limit, session);
          const doc = await mongoDb.collection(target._name).findOne({ _id: target.id }, { session });
          return makeDocSnapshot(target, doc);
        }),
        set: (ref, data, options) => { writes.push(() => exec('set', ref, data, options)); },
        update: (ref, data) => { writes.push(() => exec('update', ref, data)); },
        delete: (ref) => { writes.push(() => exec('delete', ref)); },
      };
      result = await fn(t);
      for (const w of writes) await w();
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// Lazy connection, cached across calls (and serverless invocations). Kept
// synchronous like the old ensureFirebase(): the mongodb driver auto-connects
// on the first operation, so returning the adapter immediately is safe.
function ensureFirebase() {
  if (adapter) return adapter;
  if (!MONGO_URI) {
    throw new Error('MONGODB_URI is not set. Add your MongoDB Atlas connection string to the environment.');
  }
  // Pool size is adaptive. On serverless (Vercel) every concurrent instance
  // builds its OWN pool and Atlas M0 allows only 500 connections total, so we
  // keep it tiny (5) to avoid exhausting the cluster. On an always-on server
  // (Render, or local dev) there is just ONE process, so a larger pool is safe
  // (1 x 25 = 25, far under 500) and much faster: the officer dashboard fires
  // ~20 queries at once, and a 5-connection pool forces them into slow waves.
  // Override anytime with MONGO_MAX_POOL.
  const defaultPool = process.env.VERCEL ? 5 : 25;
  mongoClient = new MongoClient(MONGO_URI, {
    ignoreUndefined: true,
    maxPoolSize: Number(process.env.MONGO_MAX_POOL) || defaultPool,
    minPoolSize: 0,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 8000,
    waitQueueTimeoutMS: 10000,
  });
  mongoDb = mongoClient.db(MONGO_DBNAME);
  adapter = {
    collection: makeCollection,
    batch: makeBatch,
    runTransaction,
    _client: () => mongoClient,
    _db: () => mongoDb,
  };
  db = adapter;
  return adapter;
}

const col = (name) => ensureFirebase().collection(name);
const docRef = (name, id) => col(name).doc(String(id));

// ============================================================
// Helpers
// ============================================================
const todayISO = () => new Date().toISOString().slice(0, 10);

function tsString(date = new Date()) {
  // Match the legacy "YYYY-MM-DD HH:MM:SS" timestamp format.
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function optionalNumericId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function normalizeResourceUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    throw new Error('Resource URL must be a valid http:// or https:// address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Resource URL must use http:// or https://');
  }
  return parsed.toString();
}

function safeStoredResourceUrl(value) {
  try { return normalizeResourceUrl(value); } catch (e) { return null; }
}

// Atomic auto-incrementing numeric ids (replaces SQL AUTOINCREMENT / Mongo).
// Reserve the next id (or a block of `by` ids, returning the LAST of them).
//
// This is a single atomic $inc on one document, deliberately NOT inside a
// transaction. The read-then-write version this replaced was a Firestore idiom:
// there, contending transactions retry cheaply. In MongoDB every concurrent
// caller collided on this one counter document, aborted, and retried, which
// serialized check-ins at a meeting (20 people scanning at once took ~22s).
// $inc has no such contention.
//
// The trade: a transaction that later aborts leaves its id unused, so sequences
// can have gaps. Ids are opaque identifiers, nothing reads them as a count, and
// a reserved block stays exclusive to its caller, so gaps are harmless.
async function allocateId(name, by = 1) {
  ensureFirebase(); // sets mongoDb on first use
  const res = await mongoDb.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: by } },
    { upsert: true, returnDocument: 'after' },
  );
  // Driver v6+ returns the document itself; older versions wrap it in `.value`.
  const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
  const seq = Number(doc && doc.seq);
  if (!Number.isFinite(seq)) throw new Error(`Could not allocate an id for ${name}`);
  return seq;
}

async function nextId(name, by = 1) {
  return allocateId(name, by);
}

// Read every document in a collection as plain objects.
async function getAll(name) {
  const snap = await col(name).get();
  return snap.docs.map(d => d.data());
}

// Recovery exports include the real Firestore document id. Most collections
// also store a numeric id field, but settings and compound-key collections do
// not, so the document id is required for an exact restore.
async function getAllForBackup(name) {
  const snap = await col(name).get();
  return snap.docs.map(d => ({ ...d.data(), _document_id: d.id }));
}

// Read a single document by numeric id.
async function getDoc(name, id) {
  const snap = await docRef(name, Number(id)).get();
  return snap.exists ? snap.data() : null;
}

// Build a Map keyed by the numeric `id` field for a whole collection.
async function loadMap(name) {
  const snap = await col(name).get();
  const map = new Map();
  snap.docs.forEach(d => { const v = d.data(); map.set(v.id, v); });
  return map;
}

// Salted scrypt hashing for officer passwords and reset codes. No plaintext
// secrets are ever stored.
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifySecret(secret, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  try {
    const check = crypto.scryptSync(String(secret), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch (e) { return false; }
}

// ============================================================
// Init / bootstrap (memoized)
// ============================================================
let initPromise = null;
function init() {
  if (!initPromise) {
    initPromise = bootstrap().catch((error) => {
      // A transient startup failure must not poison this process forever.
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}
async function bootstrap() {
  // Seed the starting balance once. Settings docs are keyed by their `key`.
  const ref = docRef('settings', 'starting_balance');
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ key: 'starting_balance', value: '3320.97' });
  }
  await ensureIndexes();
}
// Database-enforced uniqueness so two concurrent requests can't create duplicate
// officer accounts (application-level checks have a check-then-write race).
// Email indexes are partial (string only) so accounts with no email don't
// collide. Creation is best-effort: if legacy data already contains duplicates
// the index won't build, so we log and move on rather than crash startup.
async function ensureIndexes() {
  const specs = [
    ['officers', { name_lower: 1 }, { unique: true, name: 'uniq_officer_name_lower', partialFilterExpression: { name_lower: { $type: 'string' } } }],
    ['officers', { email: 1 }, { unique: true, name: 'uniq_officer_email', partialFilterExpression: { email: { $type: 'string' } } }],
  ];
  for (const [coll, keys, opts] of specs) {
    try {
      await mongoDb.collection(coll).createIndex(keys, opts);
    } catch (e) {
      console.warn(`[db] Skipped unique index ${opts.name} on "${coll}" (likely existing duplicates): ${e.message}`);
    }
  }
}

// ============================================================
// Officer passwords
// ============================================================
// An officer changes their own password (Settings), or a president/advisor sets
// a new one for them (Officer Accounts). Only the scrypt hash is stored.
async function setOfficerPassword(officerId, password) {
  await init();
  const clean = String(password || '');
  if (clean.length < 6) throw new Error('Password must be at least 6 characters');
  const o = await getDoc('officers', officerId);
  if (!o) throw new Error('Officer not found');
  await docRef('officers', Number(officerId)).update({ password_hash: hashSecret(clean) });
  return { ok: true };
}
// The officer record WITH its hash, for verifying a current password. Never
// send this to a browser: use getOfficerSessionState/listOfficers for that.
async function getOfficerForAuth(id) {
  await init();
  return getDoc('officers', id);
}

// ============================================================
// Self-serve password reset (emailed code, officer accounts)
// ============================================================
// A code is 6 digits, emailed to the officer account's address, stored ONLY as
// a scrypt hash with a 15-minute expiry and an attempt cap. One active code per
// account (a new request replaces the old one); a successful reset consumes it.
// The president/advisor "Reset Password" button in Settings works independently.
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 8;
const resetKey = (officerId) => `officer:${Number(officerId)}`;

async function resetAccountFor(input, opts = {}) {
  const requireEmail = opts.requireEmail !== false;
  const o = await findOfficerByLogin(input);
  if (!o || !o.active) throw new Error('No officer account found with that name or email.');
  if (requireEmail && !o.email) throw new Error('Your officer account has no email on file. Ask the president or advisor to reset your password.');
  return { id: o.id, name: o.name, email: o.email };
}

// Emailing reset codes is OFF unless a president/advisor explicitly turns it on
// (Email tab). It stays off while the school's mail filter is swallowing the
// codes; flipping the setting to '1' turns it straight back on, no deploy.
// Anything other than '1' - including the setting never having been written -
// means off, so nothing had to be written to the database to disable it.
function passwordResetEmailEnabled(settings) {
  return String((settings || {}).password_reset_email_enabled || '') === '1';
}

// Create (or replace) the reset code for an account. Returns the PLAINTEXT
// code exactly once so the caller can email it; only the hash is stored.
async function requestPasswordReset(input) {
  await init();
  const account = await resetAccountFor(input);
  const code = String(crypto.randomInt(100000, 1000000));
  await docRef('password_resets', resetKey(account.id)).set({
    role: 'officer', account_id: account.id,
    code_hash: hashSecret(code),
    expires_at: Date.now() + RESET_CODE_TTL_MS,
    attempts: 0,
    created_at: tsString(),
  });
  return { code, name: account.name, email: account.email, expires_min: RESET_CODE_TTL_MS / 60000 };
}

// Validate a code without consuming it (the "check code" step of the UI).
// Wrong code -> counts an attempt and throws "That code is wrong...".
async function checkPasswordResetCode(input, code) {
  await init();
  const account = await resetAccountFor(input, { requireEmail: false });
  const key = resetKey(account.id);
  // NOTE: getDoc() coerces ids to Number, which would mangle this string key,
  // so read through the raw ref instead.
  const snap = await docRef('password_resets', key).get();
  const doc = snap.exists ? snap.data() : null;
  if (!doc) throw new Error('No reset code is active for this account. Request a new one.');
  if (Date.now() > Number(doc.expires_at)) {
    await docRef('password_resets', key).delete();
    throw new Error('That code expired. Request a new one.');
  }
  if (Number(doc.attempts) >= RESET_MAX_ATTEMPTS) {
    await docRef('password_resets', key).delete();
    throw new Error('Too many wrong tries. Request a new code.');
  }
  if (!verifySecret(String(code || '').trim(), doc.code_hash)) {
    await docRef('password_resets', key).update({ attempts: Number(doc.attempts) + 1 });
    throw new Error('That code is wrong. Check it and try again.');
  }
  return account;
}

// Verify the code one final time, set the new password, and consume the code.
async function completePasswordReset(input, code, newPassword) {
  await init();
  const clean = String(newPassword || '');
  if (clean.length < 6) throw new Error('Password must be at least 6 characters.');
  const account = await checkPasswordResetCode(input, code);
  await docRef('officers', account.id).update({ password_hash: hashSecret(clean) });
  await docRef('password_resets', resetKey(account.id)).delete();
  await logAudit(account.name, 'password_reset_self', 'officer reset their password with an emailed code');
  return { ok: true, name: account.name };
}

// ============================================================
// Events
// ============================================================
// Chapter events (conferences, trips, competitions). There are no student
// accounts, so an event has no attendee roster: it is public information (date,
// time, place, cost, and payment deadlines) that shows on the chapter calendar,
// plus an optional countdown banner at the top of the public hub. Collecting
// payments is recorded by the treasurer as ordinary transactions.
function eventFields(data) {
  return {
    name: String(data.name || '').trim(),
    date: data.date || null,
    // Optional start time ("HH:MM") and place, shown on the public calendar.
    time: data.time || null,
    location: String(data.location || '').trim().slice(0, 120) || null,
    cost_per_member: Number(data.cost_per_member) || 0,
    first_payment_due: data.first_payment_due || null,
    second_payment_enabled: data.second_payment_enabled ? 1 : 0,
    second_payment_amount: Number(data.second_payment_amount) || 0,
    second_payment_due: data.second_payment_due || null,
    // Optional countdown banner on the public hub. countdown_time is the target
    // time on the event date; countdown_start (a date) is when it begins showing
    // (null means start right away).
    countdown_enabled: data.countdown_enabled ? 1 : 0,
    countdown_time: data.countdown_time || null,
    countdown_start: data.countdown_start || null,
    description: data.description || null,
  };
}
async function listEvents() {
  await init();
  const events = await getAll('events');
  events.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (a.name || '').localeCompare(b.name || ''));
  return events;
}
async function getEvent(id) {
  await init();
  return getDoc('events', id);
}
async function addEvent(data) {
  await init();
  const fields = eventFields(data);
  if (!fields.name) throw new Error('Event name is required');
  const id = await nextId('events');
  await docRef('events', id).set({ id, ...fields, created_at: tsString() });
  return getEvent(id);
}
async function updateEvent(id, data) {
  await init();
  const fields = eventFields(data);
  if (!fields.name) throw new Error('Event name is required');
  await docRef('events', Number(id)).update(fields);
  return getEvent(id);
}
async function deleteEvent(id) {
  await init();
  const eid = Number(id);
  const [txs, legacyTxs, forms, resources] = await Promise.all([
    col('transactions').where('event_id', '==', eid).get(),
    col('transactions').where('event_id', '==', String(eid)).get(),
    col('google_forms').where('event_id', '==', eid).get(),
    col('slideshows').where('event_id', '==', eid).get(),
  ]);
  const linkedTxs = new Map([...txs.docs, ...legacyTxs.docs].map(d => [d.id, d]));
  const ops = [];
  // Money already recorded stays on the books; it just loses the event link.
  linkedTxs.forEach(d => ops.push(b => b.update(d.ref, { event_id: null })));
  forms.docs.forEach(d => ops.push(b => b.update(d.ref, { event_id: null })));
  resources.docs.forEach(d => ops.push(b => b.update(d.ref, { event_id: null })));
  ops.push(b => b.delete(docRef('events', eid)));
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    ops.slice(i, i + 400).forEach(fn => fn(b));
    await b.commit();
  }
}
// Countdown banners for the public hub: enabled, not yet past, and past their
// start date. The target moment is the countdown time, else the event's start
// time, else midnight (resolved in the browser).
function activeCountdowns(events, today = todayISO()) {
  const out = [];
  for (const e of events) {
    if (!e.countdown_enabled || !e.date || e.date < today) continue;
    if (e.countdown_start && today < e.countdown_start) continue;
    out.push({ id: e.id, name: e.name, date: e.date, time: e.countdown_time || e.time || null, location: e.location || null });
  }
  out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out;
}


// ============================================================
// Transactions (the financial kind)
// ============================================================
// Transactions can point at an event. There is no member link in V2: a
// payment is recorded against the event (or nothing), never a student.
function withEventName(t, events) {
  const { member_id, ...rest } = t;
  const eventId = optionalNumericId(t.event_id);
  return {
    ...rest,
    event_id: eventId,
    event_name: eventId != null && events.has(eventId) ? events.get(eventId).name : null,
  };
}
async function listTransactions() {
  await init();
  const [txs, events] = await Promise.all([getAll('transactions'), loadMap('events')]);
  txs.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id - a.id));
  return txs.map(t => withEventName(t, events));
}
async function addTransaction(data) {
  await init();
  const id = await nextId('transactions');
  const doc = {
    id,
    date: data.date || todayISO(),
    description: data.description || '',
    type: data.type || 'income',
    category: data.category || null,
    amount: Number(data.amount) || 0,
    event_id: optionalNumericId(data.event_id),
    payment_method: data.payment_method || null,
    reference: data.reference || null,
    recorded_by: data.recorded_by || null,
    deposit_slip_id: null,
    purchase_order_id: null,
    created_at: tsString(),
  };
  await docRef('transactions', id).set(doc);
  return doc;
}
async function updateTransaction(id, data) {
  await init();
  await docRef('transactions', Number(id)).update({
    date: data.date,
    description: data.description,
    type: data.type,
    category: data.category || null,
    amount: Number(data.amount) || 0,
    event_id: optionalNumericId(data.event_id),
    payment_method: data.payment_method || null,
    reference: data.reference || null,
  });
  return getDoc('transactions', id);
}
async function deleteTransaction(id) {
  await init();
  const tid = Number(id);
  const [slips, pos] = await Promise.all([
    col('deposit_slips').where('transaction_id', '==', tid).get(),
    col('purchase_orders').where('transaction_id', '==', tid).get(),
  ]);
  const batch = db.batch();
  slips.docs.forEach(d => batch.update(d.ref, { transaction_id: null }));
  pos.docs.forEach(d => batch.update(d.ref, { transaction_id: null }));
  batch.delete(docRef('transactions', tid));
  await batch.commit();
}

async function getBalance() {
  await init();
  // Settings docs are keyed by their string `key` (e.g. "starting_balance"),
  // so read by that doc id directly. getDoc() coerces ids to Number, which
  // would turn "starting_balance" into NaN and miss the doc.
  const [startSnap, txs] = await Promise.all([
    docRef('settings', 'starting_balance').get(),
    getAll('transactions'),
  ]);
  const start = Number((startSnap.exists ? startSnap.data() : { value: '0' }).value);
  let inc = 0, exp = 0;
  for (const t of txs) {
    if (t.type === 'income') inc += Number(t.amount) || 0;
    else if (t.type === 'expense') exp += Number(t.amount) || 0;
  }
  return {
    starting_balance: start,
    income: Math.round(inc * 100) / 100,
    expenses: Math.round(exp * 100) / 100,
    balance: Math.round((start + inc - exp) * 100) / 100,
  };
}

async function getSettings() {
  await init();
  const rows = await getAll('settings');
  const o = {};
  rows.forEach(r => { o[r.key] = r.value; });
  return o;
}
async function setSetting(key, value) {
  await init();
  await docRef('settings', key).set({ key, value }, { merge: true });
}

async function logAudit(user, action, details) {
  try {
    await init();
    const id = await nextId('audit_log');
    await docRef('audit_log', id).set({
      id, user_name: user, action, details, timestamp: tsString(),
    });
  } catch (e) {
    console.error('audit log write failed:', e.message);
  }
}
async function recentAudit(n) {
  await init();
  const rows = await getAll('audit_log');
  rows.sort((a, b) => b.id - a.id);
  return rows.slice(0, Number(n) || 300);
}

// ============================================================
// Deposit slips
// ============================================================
function sumTx(txs) {
  return Math.round(txs.reduce((s, t) => s + Number(t.amount), 0) * 100) / 100;
}

async function listDepositSlips() {
  await init();
  const [slips, txs] = await Promise.all([getAll('deposit_slips'), getAll('transactions')]);
  const bySlip = new Map();
  for (const t of txs) {
    if (t.deposit_slip_id == null) continue;
    const arr = bySlip.get(t.deposit_slip_id) || [];
    arr.push(t);
    bySlip.set(t.deposit_slip_id, arr);
  }
  slips.sort((a, b) => b.id - a.id);
  return slips.map(s => {
    const list = bySlip.get(s.id) || [];
    return { ...s, total: sumTx(list), tx_count: list.length, submitted: !!s.submitted };
  });
}
async function getDepositSlip(id) {
  await init();
  const s = await getDoc('deposit_slips', id);
  if (!s) return null;
  const [txSnap, events] = await Promise.all([
    col('transactions').where('deposit_slip_id', '==', s.id).get(),
    loadMap('events'),
  ]);
  const transactions = txSnap.docs.map(d => withEventName(d.data(), events));
  transactions.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.id - b.id));
  return { ...s, transactions, total: sumTx(transactions), submitted: !!s.submitted };
}
async function createDepositSlip(data, userName) {
  await init();
  const txIds = (data.transaction_ids || []).map(Number).filter(Number.isFinite);
  if (txIds.length === 0) throw new Error('Select at least one income transaction to include in this deposit.');
  const newId = await nextId('deposit_slips');
  const slip = {
    id: newId,
    date: data.date || todayISO(),
    deposited_by: data.deposited_by || userName,
    advisor: data.advisor || null,
    account: data.account || null,
    purpose: data.purpose || null,
    notes: data.notes || null,
    submitted: 0,
    submitted_date: null,
    created_at: tsString(),
  };
  // Only attach income transactions that aren't already on a slip.
  const txDocs = await Promise.all(txIds.map(tid => docRef('transactions', tid).get()));
  const batch = db.batch();
  batch.set(docRef('deposit_slips', newId), slip);
  for (const snap of txDocs) {
    if (!snap.exists) continue;
    const t = snap.data();
    if (t.type === 'income' && t.deposit_slip_id == null) {
      batch.update(snap.ref, { deposit_slip_id: newId });
    }
  }
  await batch.commit();
  return getDepositSlip(newId);
}
async function deleteDepositSlip(id) {
  await init();
  const sid = Number(id);
  const txs = await col('transactions').where('deposit_slip_id', '==', sid).get();
  const batch = db.batch();
  txs.docs.forEach(d => batch.update(d.ref, { deposit_slip_id: null }));
  batch.delete(docRef('deposit_slips', sid));
  await batch.commit();
}
async function markDepositSubmitted(id, submitted, date) {
  await init();
  await docRef('deposit_slips', Number(id)).update({
    submitted: submitted ? 1 : 0,
    submitted_date: submitted ? (date || todayISO()) : null,
  });
  return getDepositSlip(id);
}

// ============================================================
// Purchase orders
// ============================================================
async function listPurchaseOrders() {
  await init();
  const [pos, txs] = await Promise.all([getAll('purchase_orders'), getAll('transactions')]);
  const byPo = new Map();
  for (const t of txs) {
    if (t.purchase_order_id == null) continue;
    const arr = byPo.get(t.purchase_order_id) || [];
    arr.push(t);
    byPo.set(t.purchase_order_id, arr);
  }
  pos.sort((a, b) => b.id - a.id);
  return pos.map(p => {
    const list = byPo.get(p.id) || [];
    return { ...p, total: sumTx(list), tx_count: list.length, submitted: !!p.submitted };
  });
}
async function getPurchaseOrder(id) {
  await init();
  const p = await getDoc('purchase_orders', id);
  if (!p) return null;
  const [txSnap, events] = await Promise.all([
    col('transactions').where('purchase_order_id', '==', p.id).get(),
    loadMap('events'),
  ]);
  const transactions = txSnap.docs.map(d => withEventName(d.data(), events));
  transactions.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.id - b.id));
  return { ...p, transactions, total: sumTx(transactions), submitted: !!p.submitted };
}
async function createPurchaseOrder(data, userName) {
  await init();
  const txIds = (data.transaction_ids || []).map(Number).filter(Number.isFinite);
  if (txIds.length === 0) throw new Error('Select at least one expense transaction to include in this purchase order.');

  let poNumber = data.po_number;
  if (!poNumber) {
    const year = new Date().getFullYear();
    const seq = await nextId(`po:${year}`);
    poNumber = `PO-${year}-${String(seq).padStart(4, '0')}`;
  }
  const newId = await nextId('purchase_orders');
  const po = {
    id: newId,
    po_number: poNumber,
    date: data.date || todayISO(),
    vendor_name: data.vendor_name || '',
    vendor_address: data.vendor_address || null,
    vendor_phone: data.vendor_phone || null,
    ship_to: data.ship_to || 'State High FBLA Chapter',
    authorized_by: data.authorized_by || null,
    requested_by: data.requested_by || userName,
    account: data.account || null,
    purpose: data.purpose || null,
    payment_method: data.payment_method || null,
    notes: data.notes || null,
    submitted: 0,
    submitted_date: null,
    created_at: tsString(),
  };
  const txDocs = await Promise.all(txIds.map(tid => docRef('transactions', tid).get()));
  const batch = db.batch();
  batch.set(docRef('purchase_orders', newId), po);
  for (const snap of txDocs) {
    if (!snap.exists) continue;
    const t = snap.data();
    if (t.type === 'expense' && t.purchase_order_id == null) {
      batch.update(snap.ref, { purchase_order_id: newId });
    }
  }
  await batch.commit();
  return getPurchaseOrder(newId);
}
async function deletePurchaseOrder(id) {
  await init();
  const pid = Number(id);
  const txs = await col('transactions').where('purchase_order_id', '==', pid).get();
  const batch = db.batch();
  txs.docs.forEach(d => batch.update(d.ref, { purchase_order_id: null }));
  batch.delete(docRef('purchase_orders', pid));
  await batch.commit();
}
async function markPOSubmitted(id, submitted, date) {
  await init();
  await docRef('purchase_orders', Number(id)).update({
    submitted: submitted ? 1 : 0,
    submitted_date: submitted ? (date || todayISO()) : null,
  });
  return getPurchaseOrder(id);
}

// Complete recovery snapshot used by both JSON downloads and Google Sheets.
const BACKUP_COLLECTIONS = Object.freeze([
  'events', 'transactions', 'settings', 'audit_log',
  'deposit_slips', 'purchase_orders', 'slideshows', 'announcements',
  'calendar_items', 'officer_calendar_items', 'google_forms',
  'officers', 'counters',
]);

async function backupJson() {
  await init();
  const out = { generated_at: new Date().toISOString(), schema_version: 1, tables: {} };
  const snapshots = await Promise.all(BACKUP_COLLECTIONS.map(table => getAllForBackup(table)));
  BACKUP_COLLECTIONS.forEach((table, index) => { out.tables[table] = snapshots[index]; });
  return out;
}

// ============================================================
// Slideshows
// ============================================================
// Optional cover images for resources. They live in their own collection so
// listing resources (and the public hub bundle) never carries image bytes, and
// the Sheets backup (50,000-character cells) never sees them. The browser
// shrinks an upload to a small JPEG before sending it.
const COVER_MAX_BYTES = 600 * 1024;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
async function coverStamps() {
  ensureFirebase();
  const rows = await mongoDb.collection('resource_covers').find({}, { projection: { data: 0 } }).toArray();
  return new Map(rows.map(r => [Number(r._id), r.updated_at || '']));
}
async function setResourceCover(id, dataUrl) {
  await init();
  if (!(await getDoc('slideshows', id))) throw new Error('Resource not found');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || !COVER_TYPES.includes(m[1])) throw new Error('Upload a JPEG, PNG, or WebP image.');
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) throw new Error('That image is empty.');
  if (bytes.length > COVER_MAX_BYTES) throw new Error('That image is too large. Try a smaller one.');
  const updated_at = tsString();
  await mongoDb.collection('resource_covers').replaceOne(
    { _id: String(Number(id)) },
    { _id: String(Number(id)), mime: m[1], data: m[2], size: bytes.length, updated_at },
    { upsert: true },
  );
  return { ok: true, updated_at };
}
async function removeResourceCover(id) {
  await init();
  await mongoDb.collection('resource_covers').deleteOne({ _id: String(Number(id)) });
}
// { mime, buffer, updated_at } or null.
async function getResourceCover(id) {
  await init();
  const row = await mongoDb.collection('resource_covers').findOne({ _id: String(Number(id)) });
  return row ? { mime: row.mime, buffer: Buffer.from(row.data, 'base64'), updated_at: row.updated_at } : null;
}

// includeArchived: officers see archived items; the public hub doesn't.
// Each row says whether it has a cover and when it last changed (used to
// bust the browser cache of the cover URL).
async function listSlideshows(includeArchived = true) {
  await init();
  const [rows, events, covers] = await Promise.all([getAll('slideshows'), loadMap('events'), coverStamps()]);
  rows.sort((a, b) => b.id - a.id);
  return rows
    .filter(s => includeArchived || !Number(s.archived))
    .map(s => {
      const { committee_id, school_year_id, ...rest } = s;
      const eventId = optionalNumericId(s.event_id);
      return {
        ...rest,
        url: safeStoredResourceUrl(s.url),
        event_id: eventId,
        event_name: eventId != null && events.has(eventId) ? events.get(eventId).name : null,
        has_cover: covers.has(s.id),
        cover_v: covers.get(s.id) || null,
      };
    });
}
async function addSlideshow(data, userName) {
  await init();
  const url = normalizeResourceUrl(data.url);
  const id = await nextId('slideshows');
  const doc = {
    id,
    kind: data.kind === 'resource' ? 'resource' : 'slideshow',
    title: data.title || '',
    url,
    description: data.description || null,
    // Optional: tie this resource to a chapter event (e.g. a conference).
    event_id: data.event_id ? Number(data.event_id) : null,
    // Optional: tag with a competitive event name; the public Study & Prep
    // search matches it.
    competitive_event: String(data.competitive_event || '').trim() || null,
    archived: 0,
    reviewed_at: todayISO(),
    created_by: userName || null,
    created_at: tsString(),
  };
  await docRef('slideshows', id).set(doc);
  return doc;
}
async function setSlideshowArchived(id, archived) {
  await init();
  await docRef('slideshows', Number(id)).update({ archived: archived ? 1 : 0 });
  return getDoc('slideshows', id);
}
// Mark a resource as freshly reviewed so its "needs review" flag clears.
async function markSlideshowReviewed(id) {
  await init();
  await docRef('slideshows', Number(id)).update({ reviewed_at: todayISO() });
  return getDoc('slideshows', id);
}
async function deleteSlideshow(id) {
  await init();
  await docRef('slideshows', Number(id)).delete();
  await removeResourceCover(id);
}


// ============================================================
// Announcements
// ============================================================
async function listAnnouncements() {
  await init();
  const rows = await getAll('announcements');
  // Pinned first, then newest first.
  rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.id - a.id);
  return rows;
}
// Announcements are public: everyone who opens the chapter hub sees every one.
// The category only drives the filter tabs on the public Announcements page.
const ANNOUNCEMENT_CATEGORIES = ['Chapter news', 'Competition', 'Deadlines', 'Resources'];
async function addAnnouncement(data, userName) {
  await init();
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Title is required');
  const id = await nextId('announcements');
  const doc = {
    id,
    title,
    body: data.body || null,
    category: ANNOUNCEMENT_CATEGORIES.includes(data.category) ? data.category : ANNOUNCEMENT_CATEGORIES[0],
    pinned: data.pinned ? 1 : 0,
    created_by: userName || null,
    created_at: tsString(),
  };
  await docRef('announcements', id).set(doc);
  return doc;
}
async function setAnnouncementPinned(id, pinned) {
  await init();
  await docRef('announcements', Number(id)).update({ pinned: pinned ? 1 : 0 });
  return getDoc('announcements', id);
}
async function deleteAnnouncement(id) {
  await init();
  await docRef('announcements', Number(id)).delete();
}

// ============================================================
// Calendar
// ============================================================
// Custom items (meetings, deadlines, socials...) live in `calendar_items`.
// Events from the Events tab are merged in at read time, with their payment
// due dates riding along as deadline entries, so they always stay in sync
// without duplicate records. The chapter calendar is public: the officer
// console and the public hub read the same list.
async function listCalendar() {
  await init();
  const [items, events] = await Promise.all([getAll('calendar_items'), getAll('events')]);
  const merged = [];
  for (const c of items) {
    merged.push({
      id: c.id, source: 'custom', kind: c.kind || 'meeting',
      title: c.title, date: c.date, end_date: c.end_date || null, time: c.time || null,
      location: c.location || null,
      description: c.description || null, created_by: c.created_by || null,
    });
  }
  for (const e of events) {
    if (e.date) {
      merged.push({
        id: e.id, source: 'event', kind: 'event',
        title: e.name, date: e.date, time: e.time || null, location: e.location || null,
        description: e.description || null, created_by: null,
      });
    }
    if (e.first_payment_due) {
      merged.push({
        id: e.id, source: 'payment', kind: 'deadline',
        title: `${e.name}: first payment due`, date: e.first_payment_due, time: null,
        description: e.cost_per_member ? `$${e.cost_per_member} due` : null, created_by: null,
      });
    }
    if (e.second_payment_enabled && e.second_payment_due) {
      merged.push({
        id: e.id, source: 'payment', kind: 'deadline',
        title: `${e.name}: second payment due`, date: e.second_payment_due, time: null,
        description: e.second_payment_amount ? `$${e.second_payment_amount} due` : null, created_by: null,
      });
    }
  }
  merged.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));
  return merged;
}
// Built-in kinds plus any custom event types the chapter configured.
async function calendarKinds() {
  const kinds = ['meeting', 'event', 'deadline', 'other'];
  try {
    const s = await getSettings();
    JSON.parse(s.calendar_event_types || '[]').forEach(t => { if (t && t.key) kinds.push(t.key); });
  } catch (e) { /* fall back to built-ins */ }
  return kinds;
}
async function addCalendarItem(data, userName) {
  await init();
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Title is required');
  if (!data.date) throw new Error('Date is required');
  const kinds = await calendarKinds();
  const id = await nextId('calendar_items');
  const doc = {
    id,
    title,
    date: data.date,
    // Optional multi-day span; only kept when it actually extends past the start.
    end_date: (data.end_date && data.end_date > data.date) ? data.end_date : null,
    time: data.time || null,
    location: String(data.location || '').trim().slice(0, 120) || null,
    kind: kinds.includes(data.kind) ? data.kind : 'meeting',
    description: data.description || null,
    created_by: userName || null,
    created_at: tsString(),
  };
  await docRef('calendar_items', id).set(doc);
  return doc;
}
async function updateCalendarItem(id, data) {
  await init();
  const existing = await getDoc('calendar_items', id);
  if (!existing) throw new Error('Calendar item not found');
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Title is required');
  if (!data.date) throw new Error('Date is required');
  const kinds = await calendarKinds();
  await docRef('calendar_items', Number(id)).update({
    title,
    date: data.date,
    end_date: (data.end_date && data.end_date > data.date) ? data.end_date : null,
    time: data.time || null,
    location: String(data.location || '').trim().slice(0, 120) || null,
    kind: kinds.includes(data.kind) ? data.kind : (existing.kind || 'meeting'),
    description: data.description || null,
  });
  return getDoc('calendar_items', id);
}
async function deleteCalendarItem(id) {
  await init();
  await docRef('calendar_items', Number(id)).delete();
}
// Bulk-import calendar events (e.g. from a Google Calendar iCal feed). Idempotent
// by iCal UID: re-syncing updates changed events instead of duplicating them.
// dryRun computes the plan without writing.
async function importCalendarItems(events, opts = {}) {
  await init();
  const list = Array.isArray(events) ? events : [];
  const existing = await getAll('calendar_items');
  const byUid = new Map();
  existing.forEach(c => { if (c.ics_uid) byUid.set(c.ics_uid, c); });
  const result = { added: 0, updated: 0, unchanged: 0, skipped: 0, items: [] };
  for (const ev of list) {
    const title = String(ev.title || '').trim();
    if (!ev.date || !title) { result.skipped++; continue; }
    const time = ev.time || null;
    const description = ev.description || null;
    const location = ev.location || null;
    const end_date = (ev.end_date && ev.end_date > ev.date) ? ev.end_date : null;
    const prior = ev.uid ? byUid.get(ev.uid) : null;
    if (prior) {
      const changed = prior.title !== title || prior.date !== ev.date ||
        (prior.end_date || null) !== end_date ||
        (prior.time || null) !== time || (prior.description || null) !== description ||
        (prior.location || null) !== location;
      if (changed) {
        if (!opts.dryRun) await docRef('calendar_items', prior.id).update({ title, date: ev.date, end_date, time, description, location });
        result.updated++;
        result.items.push({ action: 'update', title, date: ev.date });
      } else {
        result.unchanged++;
      }
      continue;
    }
    if (!opts.dryRun) {
      const id = await nextId('calendar_items');
      await docRef('calendar_items', id).set({
        id, title, date: ev.date, end_date, time, location,
        kind: 'event',
        description, ics_uid: ev.uid || null,
        created_by: opts.createdBy || 'Calendar sync', created_at: tsString(),
      });
    }
    result.added++;
    result.items.push({ action: 'add', title, date: ev.date });
  }
  return result;
}

// ============================================================
// Officer-only calendar (private to the officer console)
// ============================================================
// A separate calendar that lives ONLY in the officer portal. Any officer role
// (officer/treasurer/president/advisor) can add items; the public hub never
// sees these. Items are shaped like calendar_items so the same calendar grid
// renders them.
async function listOfficerCalendar() {
  await init();
  const items = await getAll('officer_calendar_items');
  const shaped = items.map(c => ({
    id: c.id, source: 'custom', kind: c.kind || 'meeting',
    title: c.title, date: c.date, end_date: c.end_date || null, time: c.time || null,
    description: c.description || null, created_by: c.created_by || null,
  }));
  shaped.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));
  return shaped;
}
async function addOfficerCalendarItem(data, userName) {
  await init();
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Title is required');
  if (!data.date) throw new Error('Date is required');
  const kinds = ['meeting', 'event', 'deadline', 'other'];
  const id = await nextId('officer_calendar_items');
  const doc = {
    id, title, date: data.date,
    end_date: (data.end_date && data.end_date > data.date) ? data.end_date : null,
    time: data.time || null,
    kind: kinds.includes(data.kind) ? data.kind : 'meeting',
    description: data.description || null,
    created_by: userName || null, created_at: tsString(),
  };
  await docRef('officer_calendar_items', id).set(doc);
  return doc;
}
async function updateOfficerCalendarItem(id, data) {
  await init();
  const existing = await getDoc('officer_calendar_items', id);
  if (!existing) throw new Error('Calendar item not found');
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Title is required');
  if (!data.date) throw new Error('Date is required');
  const kinds = ['meeting', 'event', 'deadline', 'other'];
  await docRef('officer_calendar_items', Number(id)).update({
    title,
    date: data.date,
    end_date: (data.end_date && data.end_date > data.date) ? data.end_date : null,
    time: data.time || null,
    kind: kinds.includes(data.kind) ? data.kind : (existing.kind || 'meeting'),
    description: data.description || null,
  });
  return getDoc('officer_calendar_items', id);
}
async function deleteOfficerCalendarItem(id) {
  await init();
  await docRef('officer_calendar_items', Number(id)).delete();
}

// ============================================================
// Officer accounts (individual credentials + roles)
// ============================================================
const OFFICER_ROLES = ['president', 'advisor', 'treasurer', 'officer'];
// Display metadata for the public officer list on the About page (ordering +
// default label when an officer hasn't typed a custom title).
const ROLE_META = {
  president: { rank: 0, label: 'President' },
  advisor: { rank: 1, label: 'Advisor' },
  treasurer: { rank: 2, label: 'Treasurer' },
  officer: { rank: 3, label: 'Officer' },
};
function stripOfficer(o) {
  if (!o) return o;
  const { password_hash, ...rest } = o;
  return rest;
}
// The leadership roster: every ACTIVE officer account, ordered by role, with a
// display title (custom title if set, else the role name). No credentials. The
// public About page only ever receives id/name/role/display_title from this.
async function leadershipTeam() {
  await init();
  const rows = await getAll('officers');
  return rows
    .filter(o => o.active)
    .map(o => {
      const meta = ROLE_META[o.role] || ROLE_META.officer;
      const title = String(o.title || '').trim();
      return {
        id: o.id,
        name: o.name,
        role: o.role,
        title: title || null,
        display_title: title || meta.label,
        email: o.email || null,
        rank: meta.rank,
      };
    })
    .sort((a, b) => a.rank - b.rank
      || (a.display_title || '').localeCompare(b.display_title || '')
      || (a.name || '').localeCompare(b.name || ''));
}
async function listOfficers() {
  await init();
  const rows = await getAll('officers');
  rows.sort((a, b) => (a.name_lower || '').localeCompare(b.name_lower || ''));
  return rows.map(stripOfficer);
}
async function getOfficerSessionState(id) {
  await init();
  return stripOfficer(await getDoc('officers', id));
}
async function officerCount() {
  await init();
  const snap = await col('officers').where('active', '==', 1).get();
  return snap.size;
}
// Active President/Advisor accounts (the roles that can manage officers).
async function adminCount() {
  await init();
  const snap = await col('officers').where('active', '==', 1).get();
  return snap.docs.filter(d => ['president', 'advisor'].includes(d.data().role)).length;
}
// Under strict sign-in the master password is disabled, so removing the last
// active admin would lock everyone out of officer management.
async function guardLastAdmin(officer, willBeAdminActive) {
  if (!officer || !(['president', 'advisor'].includes(officer.role) && officer.active)) return;
  if (willBeAdminActive) return;
  const strict = (await getSettings()).officer_login_strict === '1';
  if (strict && (await adminCount()) <= 1) {
    throw new Error('This is the last active President/Advisor and strict sign-in is on. Add another admin or turn off strict sign-in first.');
  }
}
async function addOfficer(data, byName) {
  await init();
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Name is required');
  const password = String(data.password || '');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  const role = OFFICER_ROLES.includes(data.role) ? data.role : 'officer';
  const existing = await findOfficerByLogin(name);
  if (existing) throw new Error('An officer with that name already exists');
  const id = await nextId('officers');
  const doc = {
    id, name,
    name_lower: name.toLowerCase(),
    email: String(data.email || '').trim().toLowerCase() || null,
    role,
    // Optional custom title shown on the public About page (e.g. "Historian",
    // "VP of Marketing"). Mainly for the plain Officer role; falls back to the
    // role name when blank.
    title: String(data.title || '').trim() || null,
    password_hash: hashSecret(password),
    active: 1,
    created_by: byName || null,
    created_at: tsString(),
  };
  await docRef('officers', id).set(doc);
  return stripOfficer(doc);
}
async function updateOfficer(id, data) {
  await init();
  const o = await getDoc('officers', id);
  if (!o) throw new Error('Officer not found');
  const update = {};
  if (data.role !== undefined) {
    if (!OFFICER_ROLES.includes(data.role)) throw new Error('Invalid role');
    update.role = data.role;
  }
  if (data.active !== undefined) update.active = data.active ? 1 : 0;
  if (data.password) {
    if (String(data.password).length < 6) throw new Error('Password must be at least 6 characters');
    update.password_hash = hashSecret(String(data.password));
  }
  if (data.email !== undefined) update.email = String(data.email || '').trim().toLowerCase() || null;
  if (data.title !== undefined) update.title = String(data.title || '').trim() || null;
  // Block demoting/deactivating the last admin while strict sign-in is on.
  const willBeAdmin = update.role !== undefined ? ['president', 'advisor'].includes(update.role) : ['president', 'advisor'].includes(o.role);
  const willBeActive = update.active !== undefined ? !!update.active : !!o.active;
  await guardLastAdmin(o, willBeAdmin && willBeActive);
  await docRef('officers', Number(id)).update(update);
  return stripOfficer(await getDoc('officers', id));
}
async function deleteOfficer(id) {
  await init();
  const oid = Number(id);
  const o = await getDoc('officers', oid);
  await guardLastAdmin(o, false);
  await docRef('officers', oid).delete();
}
// Look up by name or email (case-insensitive). Returns the raw doc (with
// hash) for login verification only. Never send this to a client.
async function findOfficerByLogin(nameOrEmail) {
  await init();
  const key = String(nameOrEmail || '').trim().toLowerCase();
  if (!key) return null;
  const byName = await col('officers').where('name_lower', '==', key).limit(1).get();
  if (!byName.empty) return byName.docs[0].data();
  const byEmail = await col('officers').where('email', '==', key).limit(1).get();
  return byEmail.empty ? null : byEmail.docs[0].data();
}
function verifyOfficerPassword(officer, password) {
  return !!officer && !!officer.active && verifySecret(password, officer.password_hash);
}


// Human label for an officer role (reuses the leadership ordering metadata).
function officerRoleLabel(role) {
  return role ? (ROLE_META[role] || ROLE_META.officer).label : null;
}

// ============================================================
// Google Forms (links officers share on the public hub)
// ============================================================
// There is no form builder and no response storage: an officer pastes a Google
// Form link and the public Forms page links out to it. Whatever a student types
// into the form lives in Google, under the chapter's Google account, never in
// this database. A closed form stays in the officer list but leaves the hub.
function googleFormFields(data) {
  const title = String(data.title || '').trim().slice(0, 120);
  if (!title) throw new Error('Title is required');
  if (!String(data.url || '').trim()) throw new Error('Paste the Google Form link.');
  return {
    title,
    url: normalizeResourceUrl(data.url),
    description: String(data.description || '').trim().slice(0, 600) || null,
    // Optional: which chapter event the form is about, and a "respond by" date
    // shown on the form's card.
    event_id: optionalNumericId(data.event_id),
    due_date: data.due_date || null,
  };
}
async function listGoogleForms(includeClosed = true) {
  await init();
  const [rows, events] = await Promise.all([getAll('google_forms'), loadMap('events')]);
  return rows
    .filter(f => includeClosed || Number(f.open))
    .map(f => {
      const eventId = optionalNumericId(f.event_id);
      return {
        ...f,
        url: safeStoredResourceUrl(f.url),
        open: Number(f.open) ? 1 : 0,
        event_id: eventId,
        event_name: eventId != null && events.has(eventId) ? events.get(eventId).name : null,
      };
    })
    // Open first; then the soonest "respond by" date; then newest.
    .sort((a, b) => (b.open - a.open)
      || ((a.due_date || '9999').localeCompare(b.due_date || '9999'))
      || (b.id - a.id));
}
async function addGoogleForm(data, userName) {
  await init();
  const fields = googleFormFields(data);
  const id = await nextId('google_forms');
  const doc = { id, ...fields, open: 1, created_by: userName || null, created_at: tsString() };
  await docRef('google_forms', id).set(doc);
  return doc;
}
async function updateGoogleForm(id, data) {
  await init();
  if (!(await getDoc('google_forms', id))) throw new Error('Form not found');
  await docRef('google_forms', Number(id)).update(googleFormFields(data));
  return getDoc('google_forms', id);
}
async function setGoogleFormOpen(id, open) {
  await init();
  await docRef('google_forms', Number(id)).update({ open: open ? 1 : 0 });
  return getDoc('google_forms', id);
}
async function deleteGoogleForm(id) {
  await init();
  await docRef('google_forms', Number(id)).delete();
}

// ============================================================
// Public hub (no sign-in)
// ============================================================
// Competitive events visitors can pick on the Study & Prep page. Officers can
// replace this list in Customization; this is the starting point.
const DEFAULT_COMPETITIVE_EVENTS = Object.freeze([
  'Accounting', 'Advanced Accounting', 'Advertising', 'Agribusiness',
  'Banking & Financial Systems', 'Broadcast Journalism', 'Business Communication',
  'Business Ethics', 'Business Law', 'Business Management', 'Business Plan',
  'Career Portfolio', 'Coding & Programming', 'Computer Applications',
  'Computer Game & Simulation Programming', 'Computer Problem Solving',
  'Customer Service', 'Cybersecurity', 'Data Analysis', 'Data Science & AI',
  'Digital Animation', 'Digital Video Production', 'Economics', 'Entrepreneurship',
  'Event Planning', 'Financial Planning', 'Financial Statement Analysis',
  'Future Business Educator', 'Future Business Leader', 'Graphic Design',
  'Healthcare Administration', 'Hospitality & Event Management',
  'Human Resource Management', 'Impromptu Speaking', 'Insurance & Risk Management',
  'International Business', 'Introduction to Business Communication',
  'Introduction to Business Concepts', 'Introduction to Business Presentation',
  'Introduction to Business Procedures', 'Introduction to FBLA',
  'Introduction to Information Technology', 'Introduction to Marketing Concepts',
  'Introduction to Parliamentary Procedure', 'Introduction to Programming',
  'Introduction to Public Speaking', 'Introduction to Retail & Merchandising',
  'Introduction to Social Media Strategy', 'Introduction to Supply Chain Management',
  'Journalism', 'Management Information Systems', 'Marketing',
  'Mobile Application Development', 'Network Design', 'Networking Infrastructures',
  'Organizational Leadership', 'Parliamentary Procedure', 'Personal Finance',
  'Project Management', 'Public Administration & Management',
  'Public Policy & Advocacy', 'Public Service Announcement', 'Public Speaking',
  'Real Estate', 'Retail Management', 'Sales Presentation', 'Securities & Investments',
  'Social Media Strategies', 'Sports & Entertainment Management',
  'Supply Chain Management', 'Technology Support & Services', 'Visual Design',
  'Website Coding & Development', 'Website Design',
]);
function competitiveEvents(settings) {
  try {
    const arr = JSON.parse((settings || {}).competitive_events || 'null');
    if (Array.isArray(arr) && arr.length) return arr.map(x => String(x || '').trim()).filter(Boolean);
  } catch (e) { /* fall back to the default list */ }
  return [...DEFAULT_COMPETITIVE_EVENTS];
}
// The display settings the public hub needs. Nothing financial or internal.
function publicConfig(s) {
  return {
    chapter_name: s.chapter_name || 'State High FBLA',
    chapter_tagline: s.chapter_tagline || 'Chapter Hub',
    calendar_event_types: s.calendar_event_types || '[]',
    home_card_title: s.home_card_title || '',
    home_card_desc: s.home_card_desc || '',
    home_card_button: s.home_card_button || '',
    home_card_link: s.home_card_link || '',
  };
}
// Everything the public hub renders, in one read. Each list is reduced to the
// fields a visitor needs; officer-only data (treasury, the officer calendar,
// archived resources, closed forms, account details) never leaves here.
async function publicHub() {
  await init();
  const [settings, announcements, calendar, resources, forms, events, team] = await Promise.all([
    getSettings(), listAnnouncements(), listCalendar(), listSlideshows(false),
    listGoogleForms(false), listEvents(), leadershipTeam(),
  ]);
  return {
    config: publicConfig(settings),
    announcements: announcements.map(a => ({
      id: a.id, title: a.title, body: a.body || null, category: a.category || 'Chapter news',
      pinned: a.pinned ? 1 : 0, created_at: a.created_at,
    })),
    calendar: calendar.map(({ created_by, ...c }) => c),
    events: events.map(e => ({
      id: e.id, name: e.name, date: e.date || null, time: e.time || null, location: e.location || null,
      description: e.description || null, cost_per_member: Number(e.cost_per_member) || 0,
      first_payment_due: e.first_payment_due || null,
      second_payment_enabled: e.second_payment_enabled ? 1 : 0,
      second_payment_amount: Number(e.second_payment_amount) || 0,
      second_payment_due: e.second_payment_due || null,
    })),
    resources: resources.map(r => ({
      id: r.id, kind: r.kind, title: r.title, url: r.url, description: r.description || null,
      event_id: r.event_id, event_name: r.event_name, competitive_event: r.competitive_event || null,
      has_cover: r.has_cover, cover_v: r.cover_v,
      created_at: r.created_at,
    })),
    forms: forms.map(f => ({
      id: f.id, title: f.title, url: f.url, description: f.description || null,
      event_name: f.event_name, due_date: f.due_date || null, created_at: f.created_at,
    })),
    countdowns: activeCountdowns(events),
    leadership: team.map(o => ({ id: o.id, name: o.name, role: o.role, display_title: o.display_title })),
  };
}

// ============================================================
// System stats (for the admin System Health panel)
// ============================================================
async function systemStats() {
  await init();
  const today = todayISO();
  const [forms, resources, events, announcements] = await Promise.all([
    getAll('google_forms'), getAll('slideshows'), getAll('events'), getAll('announcements'),
  ]);
  const staleCutoff = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  return {
    open_forms: forms.filter(f => Number(f.open)).length,
    stale_resources: resources.filter(r => !Number(r.archived) && (r.reviewed_at || (r.created_at || '').slice(0, 10)) < staleCutoff).length,
    upcoming_events: events.filter(e => e.date && e.date >= today).length,
    announcements: announcements.length,
  };
}

module.exports = {
  BACKUP_COLLECTIONS, init, ensureFirebase,
  listEvents, getEvent, addEvent, updateEvent, deleteEvent, activeCountdowns,
  setOfficerPassword, getOfficerForAuth,
  requestPasswordReset, checkPasswordResetCode, completePasswordReset, passwordResetEmailEnabled,
  listOfficers, leadershipTeam, getOfficerSessionState, officerCount, adminCount, addOfficer, updateOfficer, deleteOfficer,
  officerRoleLabel, findOfficerByLogin, verifyOfficerPassword,
  listAnnouncements, addAnnouncement, setAnnouncementPinned, deleteAnnouncement, ANNOUNCEMENT_CATEGORIES,
  listCalendar, addCalendarItem, updateCalendarItem, deleteCalendarItem, importCalendarItems,
  listOfficerCalendar, addOfficerCalendarItem, updateOfficerCalendarItem, deleteOfficerCalendarItem,
  listGoogleForms, addGoogleForm, updateGoogleForm, setGoogleFormOpen, deleteGoogleForm,
  listTransactions, addTransaction, updateTransaction, deleteTransaction, getBalance,
  getSettings, setSetting,
  logAudit, recentAudit,
  listDepositSlips, getDepositSlip, createDepositSlip, deleteDepositSlip, markDepositSubmitted,
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, deletePurchaseOrder, markPOSubmitted,
  backupJson,
  listSlideshows, addSlideshow, deleteSlideshow, setSlideshowArchived, markSlideshowReviewed,
  setResourceCover, removeResourceCover, getResourceCover,
  publicHub, publicConfig, competitiveEvents, DEFAULT_COMPETITIVE_EVENTS, systemStats,
};


