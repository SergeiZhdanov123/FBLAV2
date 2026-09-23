// Real MongoDB integration tests for the data layer.
//
// These run against the configured cluster but in a THROWAWAY database
// (`fbla_v2_test_unit`), so they never touch real data, and the database is
// dropped afterward. They are skipped automatically when MONGODB_URI is not
// configured (e.g. CI without a cluster), so `npm test` still passes offline.
const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();
// Isolate from real data: point the data layer at a disposable test database
// BEFORE it is required (the db name is read at module load).
const TEST_DB = 'fbla_v2_test_unit';
process.env.MONGODB_DB = TEST_DB;

const HAS_MONGO = !!process.env.MONGODB_URI;
const db = HAS_MONGO ? require('../db') : null;

test.after(async () => {
  if (!HAS_MONGO) return;
  try {
    const client = db.ensureFirebase()._client();
    await client.db(TEST_DB).dropDatabase(); // wipe the throwaway db
    await client.close();
  } catch (e) { /* best-effort teardown */ }
});

test('adapter: auto-increment ids, CRUD, and no _id leak', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const a = await db.addEvent({ name: 'ZZ IT A', date: '2026-10-01' });
  const b = await db.addEvent({ name: 'ZZ IT B', date: '2026-10-02' });
  assert.equal(typeof a.id, 'number');
  assert.equal(b.id, a.id + 1, 'ids auto-increment');
  const got = await db.getEvent(a.id);
  assert.equal(got.name, 'ZZ IT A');
  assert.equal(got._id, undefined, 'data() strips _id');
  await db.updateEvent(a.id, { name: 'ZZ IT A2', date: '2026-10-03', location: 'Room 1' });
  const updated = await db.getEvent(a.id);
  assert.equal(updated.date, '2026-10-03', 'update persists');
  assert.equal(updated.location, 'Room 1');
  await assert.rejects(() => db.addEvent({ name: '   ' }), /name is required/i);
  await db.deleteEvent(a.id);
  await db.deleteEvent(b.id);
  assert.equal(await db.getEvent(a.id), null, 'delete works');
});

test('adapter: update() rejects a missing document (Firestore parity)', { skip: !HAS_MONGO }, async () => {
  await db.init();
  await assert.rejects(() => db.setAnnouncementPinned(987654321, true), /No document to update/);
});

test('adapter: deposit slip batch attaches only free income transactions', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const inc = await db.addTransaction({ type: 'income', amount: 50, description: 'ZZ IT income', date: '2026-09-01' });
  const exp = await db.addTransaction({ type: 'expense', amount: 20, description: 'ZZ IT expense', date: '2026-09-01' });
  const slip = await db.createDepositSlip({ transaction_ids: [inc.id, exp.id] }, 'IT');
  assert.equal(slip.total, 50, 'the expense is not deposited');
  assert.equal(slip.transactions.length, 1);
  // A second slip can't re-deposit the same money.
  const second = await db.createDepositSlip({ transaction_ids: [inc.id] }, 'IT');
  assert.equal(second.total, 0);
  const po = await db.createPurchaseOrder({ transaction_ids: [exp.id], vendor_name: 'ZZ Vendor' }, 'IT');
  assert.equal(po.total, 20);
  assert.match(po.po_number, /^PO-\d{4}-\d{4}$/);
  // Deleting the transaction clears its slip/PO links without breaking them.
  await db.deleteTransaction(inc.id);
  assert.equal((await db.getDepositSlip(slip.id)).total, 0);
  await db.deleteDepositSlip(slip.id); await db.deleteDepositSlip(second.id);
  await db.deletePurchaseOrder(po.id); await db.deleteTransaction(exp.id);
});

test('adapter: deleting an event keeps its money and links, just unlinked', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const ev = await db.addEvent({ name: 'ZZ IT Trip', date: '2026-12-01', countdown_enabled: 1 });
  const tx = await db.addTransaction({ type: 'income', amount: 75, description: 'ZZ IT trip deposit', event_id: ev.id });
  const form = await db.addGoogleForm({ title: 'ZZ IT trip form', url: 'https://forms.gle/zz', event_id: ev.id }, 'IT');
  const res = await db.addSlideshow({ kind: 'resource', title: 'ZZ IT packing list', event_id: ev.id }, 'IT');
  assert.equal((await db.listTransactions()).find(t => t.id === tx.id).event_name, 'ZZ IT Trip');
  await db.deleteEvent(ev.id);
  assert.equal((await db.listTransactions()).find(t => t.id === tx.id).event_id, null, 'transaction kept, unlinked');
  assert.equal((await db.listGoogleForms()).find(f => f.id === form.id).event_id, null, 'form kept, unlinked');
  assert.equal((await db.listSlideshows()).find(s => s.id === res.id).event_id, null, 'resource kept, unlinked');
  await db.deleteTransaction(tx.id); await db.deleteGoogleForm(form.id); await db.deleteSlideshow(res.id);
});

test('adapter: the calendar merges events and their payment deadlines', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const ev = await db.addEvent({
    name: 'ZZ IT States', date: '2027-04-12', time: '09:00', location: 'Hershey',
    cost_per_member: 150, first_payment_due: '2027-02-01',
    second_payment_enabled: 1, second_payment_amount: 75, second_payment_due: '2027-03-01',
  });
  const cal = (await db.listCalendar()).filter(c => c.id === ev.id && c.source !== 'custom');
  const bySource = (s) => cal.filter(c => c.source === s);
  assert.equal(bySource('event').length, 1);
  assert.equal(bySource('event')[0].location, 'Hershey');
  assert.equal(bySource('payment').length, 2, 'both payment deadlines show');
  assert.ok(bySource('payment').every(c => c.kind === 'deadline'));
  await db.deleteEvent(ev.id);
});

test('adapter: calendar spanning dates, location, edit, and iCal import', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const item = await db.addCalendarItem({ title: 'ZZ IT Conference', date: '2027-03-10', end_date: '2027-03-12', kind: 'event', location: 'Room 9' }, 'IT');
  assert.equal(item.end_date, '2027-03-12');
  assert.equal(item.location, 'Room 9');
  const bogus = await db.addCalendarItem({ title: 'ZZ IT Bogus Span', date: '2027-03-10', end_date: '2027-03-01' }, 'IT');
  assert.equal(bogus.end_date, null, 'end before start is dropped');
  await db.updateCalendarItem(item.id, { title: 'ZZ IT Conference v2', date: '2027-03-11', end_date: null, kind: 'event', location: '' });
  const listed = (await db.listCalendar()).find(c => c.id === item.id && c.source === 'custom');
  assert.equal(listed.title, 'ZZ IT Conference v2');
  assert.equal(listed.end_date, null, 'span cleared');
  assert.equal(listed.location, null, 'location cleared');
  await assert.rejects(() => db.updateCalendarItem(999999, { title: 'x', date: '2027-01-01' }), /not found/i);

  // iCal import is idempotent by UID; a changed location counts as an update.
  const feed = (loc) => [{ uid: 'zz-span@t', title: 'ZZ IT States', date: '2027-04-12', end_date: '2027-04-14', time: null, description: null, location: loc }];
  let r = await db.importCalendarItems(feed('Hershey Lodge'));
  assert.equal(r.added, 1);
  r = await db.importCalendarItems(feed('Hershey Lodge'));
  assert.equal(r.unchanged, 1, 'idempotent');
  r = await db.importCalendarItems(feed('Giant Center'));
  assert.equal(r.updated, 1, 'location change detected on re-sync');
  const synced = (await db.listCalendar()).find(c => c.title === 'ZZ IT States' && c.source === 'custom');
  assert.equal(synced.location, 'Giant Center');
  await db.deleteCalendarItem(item.id); await db.deleteCalendarItem(bogus.id); await db.deleteCalendarItem(synced.id);
});

test('adapter: the officer calendar never reaches the public calendar', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const item = await db.addOfficerCalendarItem({ title: 'ZZ IT Officer Sync', date: '2026-11-01', kind: 'meeting' }, 'IT');
  assert.ok((await db.listOfficerCalendar()).some(c => c.id === item.id));
  assert.ok(!(await db.listCalendar()).some(c => c.title === 'ZZ IT Officer Sync'));
  const hub = await db.publicHub();
  assert.ok(!JSON.stringify(hub).includes('ZZ IT Officer Sync'));
  await db.deleteOfficerCalendarItem(item.id);
});

test('adapter: Google Form links validate URLs and hide when closed', { skip: !HAS_MONGO }, async () => {
  await db.init();
  await assert.rejects(() => db.addGoogleForm({ title: 'ZZ bad', url: 'javascript:alert(1)' }, 'IT'), /http/i);
  await assert.rejects(() => db.addGoogleForm({ title: 'ZZ no link', url: '' }, 'IT'), /link/i);
  await assert.rejects(() => db.addGoogleForm({ title: '', url: 'https://forms.gle/x' }, 'IT'), /Title/);
  const f = await db.addGoogleForm({ title: 'ZZ IT Interest form', url: 'https://forms.gle/abc', due_date: '2026-10-10' }, 'IT');
  assert.equal(f.open, 1);
  assert.ok((await db.publicHub()).forms.some(x => x.id === f.id));
  await db.setGoogleFormOpen(f.id, false);
  assert.ok(!(await db.publicHub()).forms.some(x => x.id === f.id), 'a hidden form leaves the hub');
  assert.ok((await db.listGoogleForms()).some(x => x.id === f.id), 'but stays in the officer list');
  await db.updateGoogleForm(f.id, { title: 'ZZ IT Interest form v2', url: 'https://docs.google.com/forms/d/e/x/viewform' });
  assert.equal((await db.listGoogleForms()).find(x => x.id === f.id).title, 'ZZ IT Interest form v2');
  await db.deleteGoogleForm(f.id);
});

test('adapter: the public hub carries no private fields', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const o = await db.addOfficer({ name: 'ZZ IT Public Officer', email: 'zzpublic@example.com', role: 'officer', password: 'secret1' }, 'IT');
  const a = await db.addAnnouncement({ title: 'ZZ IT hello', body: 'Hi all', category: 'Competition', pinned: 1 }, 'ZZ IT Poster');
  const archived = await db.addSlideshow({ kind: 'slideshow', title: 'ZZ IT archived deck' }, 'IT');
  await db.setSlideshowArchived(archived.id, true);
  await db.addTransaction({ type: 'expense', amount: 9, description: 'ZZ IT private expense' });
  const blob = JSON.stringify(await db.publicHub());
  for (const secret of ['zzpublic@example.com', 'password_hash', 'ZZ IT Poster', 'created_by', 'ZZ IT archived deck', 'ZZ IT private expense', 'starting_balance']) {
    assert.ok(!blob.includes(secret), `public hub leaked ${secret}`);
  }
  assert.ok(blob.includes('ZZ IT hello'));
  const ann = (await db.publicHub()).announcements.find(x => x.id === a.id);
  assert.equal(ann.category, 'Competition');
  const bad = await db.addAnnouncement({ title: 'ZZ IT odd category', category: 'Nonsense' }, 'IT');
  assert.equal(bad.category, 'Chapter news', 'unknown categories fall back');
  await db.deleteOfficer(o.id); await db.deleteAnnouncement(a.id); await db.deleteAnnouncement(bad.id);
});

test('adapter: leadership team lists active officers with titles, ordered by role', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const pres = await db.addOfficer({ name: 'ZZ IT Prez', role: 'president', password: 'secret1' }, 'IT');
  const off = await db.addOfficer({ name: 'ZZ IT Historian', role: 'officer', title: 'Historian', password: 'secret1' }, 'IT');
  const gone = await db.addOfficer({ name: 'ZZ IT Former', role: 'officer', password: 'secret1' }, 'IT');
  await db.updateOfficer(gone.id, { active: 0 });
  const ours = (await db.leadershipTeam()).filter(t => t.name.startsWith('ZZ IT'));
  assert.ok(!ours.some(t => t.id === gone.id), 'disabled officers are excluded');
  const prezRow = ours.find(t => t.id === pres.id);
  const offRow = ours.find(t => t.id === off.id);
  assert.equal(prezRow.display_title, 'President');
  assert.equal(offRow.display_title, 'Historian');
  assert.ok(prezRow.rank < offRow.rank, 'president sorts before a plain officer');
  assert.equal(prezRow.password_hash, undefined);
  await db.deleteOfficer(pres.id); await db.deleteOfficer(off.id); await db.deleteOfficer(gone.id);
});

test('adapter: officer passwords (self change, admin reset, duplicates)', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const o = await db.addOfficer({ name: 'ZZ IT Pw', email: 'zzpw@example.com', role: 'treasurer', password: 'firstpw1' }, 'IT');
  await assert.rejects(() => db.addOfficer({ name: 'zz it pw', password: 'another1' }, 'IT'), /already exists/);
  await assert.rejects(() => db.addOfficer({ name: 'ZZ Short', password: 'abc' }, 'IT'), /6 characters/);
  let raw = await db.findOfficerByLogin('ZZPW@example.com');
  assert.equal(raw.id, o.id, 'login by email is case-insensitive');
  assert.equal(db.verifyOfficerPassword(raw, 'firstpw1'), true);
  await db.setOfficerPassword(o.id, 'secondpw2');
  raw = await db.getOfficerForAuth(o.id);
  assert.equal(db.verifyOfficerPassword(raw, 'secondpw2'), true);
  assert.equal(db.verifyOfficerPassword(raw, 'firstpw1'), false);
  // The president/advisor reset path is updateOfficer({ password }).
  await db.updateOfficer(o.id, { password: 'adminset3' });
  raw = await db.getOfficerForAuth(o.id);
  assert.equal(db.verifyOfficerPassword(raw, 'adminset3'), true);
  // A disabled account can't sign in even with the right password.
  await db.updateOfficer(o.id, { active: 0 });
  assert.equal(db.verifyOfficerPassword(await db.getOfficerForAuth(o.id), 'adminset3'), false);
  await db.deleteOfficer(o.id);
});

test('adapter: officer password reset by emailed code (code lifecycle)', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const o = await db.addOfficer({ name: 'ZZ IT Reset', email: 'zzreset@example.com', role: 'officer', password: 'oldpass1' }, 'IT');
  const r = await db.requestPasswordReset('zzreset@example.com');
  assert.match(r.code, /^\d{6}$/);
  assert.equal(r.email, 'zzreset@example.com');
  await assert.rejects(() => db.checkPasswordResetCode('zzreset@example.com', '000000'), /wrong/i);
  const acct = await db.checkPasswordResetCode('ZZ IT Reset', r.code);
  assert.equal(acct.id, o.id, 'name or email both work');
  await db.completePasswordReset('zzreset@example.com', r.code, 'newpass9');
  const fresh = await db.findOfficerByLogin('zzreset@example.com');
  assert.equal(db.verifyOfficerPassword(fresh, 'newpass9'), true);
  assert.equal(db.verifyOfficerPassword(fresh, 'oldpass1'), false);
  await assert.rejects(() => db.checkPasswordResetCode('zzreset@example.com', r.code), /no reset code/i, 'a code works once');
  await assert.rejects(() => db.requestPasswordReset('nobody@example.com'), /no officer account/i);
  const noEmail = await db.addOfficer({ name: 'ZZ IT NoEmail', role: 'officer', password: 'secret1' }, 'IT');
  await assert.rejects(() => db.requestPasswordReset('ZZ IT NoEmail'), /no email on file/i);
  const r2 = await db.requestPasswordReset('zzreset@example.com');
  await assert.rejects(() => db.completePasswordReset('zzreset@example.com', r2.code, 'abc'), /6 characters/i);
  await db.deleteOfficer(o.id); await db.deleteOfficer(noEmail.id);
});

test('adapter: the last admin is protected while strict sign-in is on', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const admin = await db.addOfficer({ name: 'ZZ IT Only Admin', role: 'advisor', password: 'secret1' }, 'IT');
  // Other admins may exist from other tests; only assert when this is the last.
  if ((await db.adminCount()) === 1) {
    await db.setSetting('officer_login_strict', '1');
    await assert.rejects(() => db.updateOfficer(admin.id, { active: 0 }), /last active President\/Advisor/);
    await assert.rejects(() => db.deleteOfficer(admin.id), /last active President\/Advisor/);
    await db.setSetting('officer_login_strict', '0');
  }
  await db.deleteOfficer(admin.id);
});

test('adapter: resources keep event and competitive-event tags', { skip: !HAS_MONGO }, async () => {
  await db.init();
  await assert.rejects(() => db.addSlideshow({ kind: 'resource', title: 'ZZ bad', url: 'ftp://x' }, 'IT'), /http/);
  const r = await db.addSlideshow({ kind: 'resource', title: 'ZZ IT PF guide', url: 'https://example.com/pf', competitive_event: ' Personal Finance ' }, 'IT');
  assert.equal(r.competitive_event, 'Personal Finance');
  assert.equal(r.committee_id, undefined, 'no committee targeting in V2');
  const pub = (await db.publicHub()).resources.find(x => x.id === r.id);
  assert.equal(pub.competitive_event, 'Personal Finance');
  await db.markSlideshowReviewed(r.id);
  await db.deleteSlideshow(r.id);
});

test('adapter: General Resources are their own kind and reach the public hub', { skip: !HAS_MONGO }, async () => {
  await db.init();
  const g = await db.addSlideshow({ kind: 'general', title: 'ZZ IT Chapter handbook', url: 'https://example.com/handbook' }, 'IT');
  assert.equal(g.kind, 'general');
  const odd = await db.addSlideshow({ kind: 'nonsense', title: 'ZZ IT unknown kind' }, 'IT');
  assert.equal(odd.kind, 'slideshow', 'unknown kinds fall back to meeting resources');
  const pub = (await db.publicHub()).resources.find(r => r.id === g.id);
  assert.equal(pub.kind, 'general');
  await db.setSlideshowArchived(g.id, true);
  assert.ok(!(await db.publicHub()).resources.some(r => r.id === g.id), 'archived general resources leave the hub');
  await db.deleteSlideshow(g.id); await db.deleteSlideshow(odd.id);
});
