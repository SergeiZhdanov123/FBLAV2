// Copy everything that is not student data from FBLABudgeterApp's database (V1)
// into this app's database (V2).
//
//   node scripts/migrate-from-v1.js            # dry run: prints what would move
//   node scripts/migrate-from-v1.js --apply    # copies into an EMPTY V2 database
//   node scripts/migrate-from-v1.js --apply --replace
//       # refreshes the copied collections from V1 again. This OVERWRITES
//       # anything created in V2 in those collections since the last copy.
//
// V1 is only ever READ. Nothing in the V1 database is changed or deleted.
// Source: V1_MONGODB_DB (default "fbla"). Target: MONGODB_DB (default "fbla_v2").
//
// Documents keep their original ids (and Mongo _id), so officer passwords,
// transaction numbers, deposit-slip links, and the Google Calendar sync (which
// matches events by iCal UID) all carry over unchanged. Student records are not
// copied: members, dues, attendance, points, form responses, notifications,
// forum, buddy groups, messages, and anything aimed at specific members.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const SOURCE_DB = process.env.V1_MONGODB_DB || 'fbla';
const TARGET_DB = process.env.MONGODB_DB || 'fbla_v2';
const APPLY = process.argv.includes('--apply');
const REPLACE = process.argv.includes('--replace');

// Settings that still mean something in V2. Member-only settings (default
// dues, onboarding, sign-ups, leaderboard, digest) are left behind.
const SETTINGS_KEYS = new Set([
  'starting_balance', 'chapter_name', 'chapter_tagline', 'transaction_categories',
  'calendar_event_types', 'reminder_lead_days', 'home_card_title', 'home_card_desc',
  'home_card_button', 'home_card_link', 'google_calendar_ical_url', 'google_calendar_last_sync',
  'officer_login_strict', 'password_reset_email_enabled',
]);
// Activity-log entries that record officer work and carry no student data.
// Member logins, registrations, form submissions, check-ins, and the like stay
// behind.
const AUDIT_ACTIONS = new Set([
  'officer_login', 'officer_login_failed', 'officer_add', 'officer_update', 'officer_delete',
  'officer_login_strict', 'officer_password_change', 'password_reset_email',
  'calendar_add', 'calendar_update', 'calendar_delete', 'google_calendar_connect', 'google_calendar_sync',
  'officer_calendar_add', 'officer_calendar_update', 'officer_calendar_delete',
  'event_add', 'event_update', 'event_delete',
  'tx_add', 'tx_update', 'tx_delete', 'set_starting_balance',
  'deposit_slip_create', 'deposit_slip_delete', 'deposit_slip_submitted',
  'po_create', 'po_delete', 'po_submitted',
  'announcement_add', 'announcement_pin', 'announcement_delete',
  'slideshow_add', 'slideshow_delete', 'slideshow_archive', 'slideshow_reviewed',
  'customization_update', 'backup_download', 'email_test', 'email_digest',
]);
const strip = (doc, keys) => { const out = { ...doc }; keys.forEach(k => delete out[k]); return out; };

// Each rule turns the V1 documents of one collection into V2 documents, and
// says why anything was left out.
const RULES = {
  officers: (docs) => ({ keep: docs }),
  settings: (docs) => ({
    keep: docs.filter(d => SETTINGS_KEYS.has(d._id)),
    skipped: docs.filter(d => !SETTINGS_KEYS.has(d._id)).map(d => `${d._id} (member-only setting)`),
  }),
  events: (docs) => ({
    keep: docs.map(e => strip(e, ['percent_tiers', 'rsvp_enabled'])),
    note: 'attendee lists and per-student payments are not copied',
  }),
  transactions: (docs) => ({
    keep: docs.map(t => strip(t, ['member_id'])),
    note: 'member links removed; amounts, descriptions, and event links kept',
  }),
  deposit_slips: (docs) => ({ keep: docs }),
  purchase_orders: (docs) => ({ keep: docs }),
  calendar_items: (docs) => ({
    keep: docs.filter(c => !(c.committee_id && c.visibility !== 'public')).map(c => strip(c, ['committee_id', 'visibility'])),
    skipped: docs.filter(c => c.committee_id && c.visibility !== 'public').map(c => `"${c.title}" (committee-only meeting)`),
  }),
  officer_calendar_items: (docs) => ({ keep: docs }),
  slideshows: (docs) => ({
    keep: docs.filter(s => s.committee_id == null).map(s => strip(s, ['committee_id', 'school_year_id'])),
    skipped: docs.filter(s => s.committee_id != null).map(s => `"${s.title}" (committee-only resource)`),
  }),
  announcements: (docs) => ({
    keep: docs.filter(a => !Array.isArray(a.member_ids) || !a.member_ids.length)
      .map(a => ({ ...strip(a, ['member_ids', 'audience_label']), category: a.category || 'Chapter news' })),
    skipped: docs.filter(a => Array.isArray(a.member_ids) && a.member_ids.length).map(a => `"${a.title}" (sent to specific members only)`),
  }),
  audit_log: (docs) => {
    const keep = docs.filter(a => AUDIT_ACTIONS.has(a.action) ||
      (a.action === 'password_reset_requested' && /^officer\b/.test(a.details || '')));
    return { keep, note: `${docs.length - keep.length} student-related entries left behind (member logins, sign-ups, form submissions...)` };
  },
};
const MIGRATED = Object.keys(RULES);

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in .env');
  if (SOURCE_DB === TARGET_DB) throw new Error(`Source and target are both "${SOURCE_DB}". Refusing to run.`);
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const src = client.db(SOURCE_DB);
    const dst = client.db(TARGET_DB);
    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}: ${SOURCE_DB} (V1, read only) -> ${TARGET_DB} (V2)\n`);

    // Refuse to mix into a V2 database that already has data, unless asked to.
    const existing = [];
    for (const name of [...MIGRATED, 'counters']) {
      const n = await dst.collection(name).countDocuments();
      if (n) existing.push(`${name}: ${n}`);
    }
    if (APPLY && existing.length && !REPLACE) {
      throw new Error(`The V2 database already has data (${existing.join(', ')}). Re-run with --replace to overwrite the copied collections.`);
    }

    const plan = {};
    for (const name of MIGRATED) {
      const docs = await src.collection(name).find().toArray();
      const r = RULES[name](docs);
      plan[name] = { source: docs.length, docs: r.keep, skipped: r.skipped || [], note: r.note };
      console.log(`${name.padEnd(24)} ${String(r.keep.length).padStart(4)} of ${String(docs.length).padEnd(4)}${r.note ? '  ' + r.note : ''}`);
      (r.skipped || []).forEach(s => console.log(`${' '.repeat(28)}left behind: ${s}`));
    }

    // Id counters: carry over V1's value for every copied collection (and the
    // yearly PO-number counters), and never go below the highest copied id, so
    // new V2 records can't reuse an id.
    const counters = [];
    for (const c of await src.collection('counters').find().toArray()) {
      if (!MIGRATED.includes(c._id) && !/^po:\d{4}$/.test(c._id)) continue;
      const maxId = Math.max(0, ...(plan[c._id] ? plan[c._id].docs.map(d => Number(d.id) || 0) : [0]));
      counters.push({ _id: c._id, seq: Math.max(Number(c.seq) || 0, maxId) });
    }
    console.log(`${'counters'.padEnd(24)} ${String(counters.length).padStart(4)}  ${counters.map(c => `${c._id}=${c.seq}`).join(', ')}`);

    const notCopied = ['members', 'event_attendees', 'forms', 'form_responses', 'notifications', 'point_ledger',
      'point_submissions', 'attendance_sessions', 'attendance_records', 'tasks', 'task_completions', 'committees',
      'committee_members', 'forum_posts', 'forum_replies', 'buddy_groups', 'buddy_members', 'buddy_messages',
      'messages', 'signup_events', 'event_signups', 'school_years', 'analytics', 'password_resets', 'point_activity_types'];
    const leftBehind = [];
    for (const name of notCopied) {
      const n = await src.collection(name).countDocuments();
      if (n) leftBehind.push(`${name} (${n})`);
    }
    console.log(`\nNot copied (student features V2 does not have): ${leftBehind.join(', ') || 'none'}`);
    const forms = await src.collection('forms').find({}, { projection: { title: 1, status: 1 } }).toArray();
    if (forms.length) {
      console.log('V1 in-app forms (recreate as Google Forms if still needed):');
      forms.forEach(f => console.log(`  - ${f.title} [${f.status}]`));
    }

    if (!APPLY) { console.log('\nDry run only. Re-run with --apply to copy.'); return; }

    for (const name of MIGRATED) {
      const coll = dst.collection(name);
      if (REPLACE) await coll.deleteMany({});
      if (plan[name].docs.length) {
        await coll.bulkWrite(plan[name].docs.map(d => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: true });
      }
    }
    if (REPLACE) await dst.collection('counters').deleteMany({ _id: { $in: counters.map(c => c._id) } });
    if (counters.length) {
      await dst.collection('counters').bulkWrite(counters.map(c => ({ replaceOne: { filter: { _id: c._id }, replacement: c, upsert: true } })));
    }

    // Verify: every copied document is in V2 exactly as planned, and officer
    // password hashes are byte-for-byte identical to V1's.
    const problems = [];
    for (const name of MIGRATED) {
      const want = plan[name].docs;
      const got = await dst.collection(name).find().toArray();
      if (got.length !== want.length) problems.push(`${name}: expected ${want.length}, found ${got.length}`);
      const byId = new Map(got.map(d => [String(d._id), d]));
      for (const w of want) {
        const g = byId.get(String(w._id));
        if (!g || JSON.stringify(g) !== JSON.stringify(w)) problems.push(`${name}/${w._id} does not match`);
      }
    }
    const v1Officers = await src.collection('officers').find().toArray();
    const v2Officers = new Map((await dst.collection('officers').find().toArray()).map(o => [String(o._id), o]));
    for (const o of v1Officers) {
      const copy = v2Officers.get(String(o._id));
      if (!copy || copy.password_hash !== o.password_hash) problems.push(`officer ${o.name}: password hash differs`);
    }
    if (problems.length) throw new Error('Verification failed:\n  ' + problems.join('\n  '));
    console.log(`\nCopied and verified. ${v1Officers.length} officer accounts keep their V1 passwords.`);
  } finally {
    await client.close();
  }
}

main().catch(e => { console.error('\n' + e.message); process.exit(1); });
