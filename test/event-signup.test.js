// Event Sign-Up: name matching, member-list parsing, and the database rules
// (capacity, team size, one event per person, chapter projects, member list,
// grade limits, and races). The database tests run in a throwaway database.
const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();
const TEST_DB = 'fbla_v2_test_signup';
process.env.MONGODB_DB = TEST_DB;
const HAS_MONGO = !!process.env.MONGODB_URI;
const db = require('../db');
const su = require('../event-signup');

// ---------- pure ----------
const ROSTER = [
  { id: 1, first_name: 'Jane', last_name: 'Doe', grade: '11' },
  { id: 2, first_name: 'Alex', last_name: 'Smith', grade: '9' },
  { id: 3, first_name: 'Alex', last_name: 'Jones', grade: '10' },
  { id: 4, first_name: 'Mary Kate', last_name: 'Olsen', grade: '12' },
  { id: 5, first_name: 'José', last_name: "O'Brien-Smith", grade: '10' },
  { id: 6, first_name: 'Robert', last_name: 'Lee', preferred_name: 'Bobby', grade: '12' },
  { id: 7, first_name: 'Maria', last_name: 'de la Cruz' },
  { id: 8, first_name: 'Sam', last_name: 'Park', grade: '9' },
  { id: 9, first_name: 'Sam', last_name: 'Park', grade: '12' },
];
const who = (s) => { const r = su.resolveName(s, ROSTER); return r.ok ? r.name : `ERR: ${r.error}`; };

test('names: full, reversed, middle, initial, first-only, preferred, accents', () => {
  assert.equal(who('Jane Doe'), 'Jane Doe');
  assert.equal(who('  jane   DOE '), 'Jane Doe');
  assert.equal(who('Doe, Jane'), 'Jane Doe');
  assert.equal(who('Jane Marie Doe'), 'Jane Doe');
  assert.equal(who('jane'), 'Jane Doe', 'first name alone when only one member has it');
  assert.equal(who('Alex S'), 'Alex Smith');
  assert.equal(who('Alex S.'), 'Alex Smith');
  assert.equal(who('mary kate olsen'), 'Mary Kate Olsen');
  assert.equal(who('Mary Kate'), 'Mary Kate Olsen');
  assert.equal(who('Mary Olsen'), 'Mary Kate Olsen');
  assert.equal(who('jose obrien smith'), "José O'Brien-Smith");
  assert.equal(who("José O'Brien-Smith"), "José O'Brien-Smith");
  assert.equal(who('Bobby Lee'), 'Robert Lee');
  assert.equal(who('Bobby'), 'Robert Lee');
  assert.equal(who('Maria de la Cruz'), 'Maria de la Cruz');
});

test('names: ambiguous or unknown names are refused', () => {
  assert.match(who('Alex'), /More than one member matches "Alex"/);
  assert.match(who('Sam Park'), /More than one member is named Sam Park/);
  assert.match(who('Janet Doe'), /isn't on the chapter's FBLA member list/);
  assert.match(who('Smith'), /isn't on/, 'a last name alone is not a match');
  assert.match(who(''), /Enter a name/);
});

test('names: without a member list, any first + last name', () => {
  assert.deepEqual(su.resolveName('jane doe', []), { ok: true, name: 'Jane Doe', key: 'jane doe', roster_id: null, grade: null });
  assert.equal(su.resolveName('McKenzie DeVries', []).name, 'McKenzie DeVries', 'mixed case kept as typed');
  assert.match(su.resolveName('Jane', []).error, /first and last name/);
});

test('names: two members with the same name get separate keys', () => {
  const r = su.resolveName('Jane Doe', [...ROSTER, { id: 10, first_name: 'Jane', last_name: 'Doe' }]);
  assert.equal(r.ok, false);
});

test('member list: paste formats', () => {
  let r = su.parseRosterText('Jane Doe\nDoe, John\n  alex   smith  \n\nMaria de la Cruz');
  assert.deepEqual(r.rows.map(x => [x.first_name, x.last_name]), [['Jane', 'Doe'], ['John', 'Doe'], ['Alex', 'Smith'], ['Maria', 'de la Cruz']]);
  r = su.parseRosterText('Last Name,First Name,Grade,Preferred Name\nDoe,Jane,11,\nLee,Robert,senior,Bobby\n"Smith, Jr.",Alex,9,');
  assert.deepEqual(r.rows.map(x => [x.first_name, x.last_name, x.grade, x.preferred_name]), [['Jane', 'Doe', '11', null], ['Robert', 'Lee', '12', 'Bobby'], ['Alex', 'Smith, Jr.', '9', null]]);
  r = su.parseRosterText('Jane\tDoe\t10\nAlex\tSmith\t');
  assert.deepEqual(r.rows.map(x => [x.first_name, x.last_name, x.grade]), [['Jane', 'Doe', '10'], ['Alex', 'Smith', null]]);
  r = su.parseRosterText('Jane,Doe,10\nAlex,Smith,9');
  assert.deepEqual(r.rows.map(x => [x.first_name, x.last_name, x.grade]), [['Jane', 'Doe', '10'], ['Alex', 'Smith', '9']]);
  r = su.parseRosterText('First,Last,Grade\nJane,,10\nAlex,Smith,7');
  assert.equal(r.rows.length, 0);
  assert.deepEqual(r.problems.map(p => p.line), [2, 3]);
});

test('defaults: all 78 PA FBLA events with guide numbers', () => {
  const d = su.DEFAULT_EVENTS;
  assert.equal(d.length, 78);
  const by = Object.fromEntries(d.map(e => [e.name, e]));
  assert.deepEqual([by['Accounting'].team, by['Accounting'].max_entries], [false, 3]);
  assert.deepEqual([by['Public Speaking'].max_entries, by['Impromptu Speaking'].max_entries], [2, 2]);
  assert.deepEqual([by['Marketing'].team, by['Marketing'].min_size, by['Marketing'].max_size, by['Marketing'].max_entries], [true, 1, 3, 3]);
  assert.deepEqual([by['Parliamentary Procedure'].min_size, by['Parliamentary Procedure'].max_size], [4, 5]);
  assert.deepEqual([by['Business Plan'].max_entries, by['Website Design'].max_entries], [2, 2]);
  assert.deepEqual([by['Community Service Project'].chapter, by['Community Service Project'].max_entries], [true, 1]);
  assert.equal(d.filter(e => e.chapter).length, 4);
  assert.equal(d.filter(e => e.grades === '9-10').length, 13);
  for (const e of d) su.cleanEvent(e); // every default passes validation
});

// ---------- database ----------
const skip = { skip: !HAS_MONGO };
let ev; // name -> event
const err = async (p) => { try { await p; } catch (e) { return e; } assert.fail('expected an error'); };

test.after(async () => {
  if (!HAS_MONGO) return;
  try { const c = db.ensureFirebase()._client(); await c.db(TEST_DB).dropDatabase(); await c.close(); } catch (e) { /* best effort */ }
});

test('db: load the default events once', skip, async () => {
  await db.init();
  const c = db.ensureFirebase()._client();
  await c.db(TEST_DB).dropDatabase();
  await db.init();
  assert.deepEqual(await su.loadDefaultEvents(), { added: 78, already: 0 });
  assert.deepEqual(await su.loadDefaultEvents(), { added: 0, already: 78 });
  ev = Object.fromEntries((await su.listEvents()).map(e => [e.name, e]));
  assert.equal(ev['Marketing'].taken, 0);
});

test('db: closed sign-up refuses members, officers can still add', skip, async () => {
  await db.setSetting('event_signup_open', '0');
  const e = await err(su.createSignup({ eventId: ev['Accounting'].id, names: ['Ann Able'] }));
  assert.equal(e.status, 403);
  const s = await su.createSignup({ eventId: ev['Accounting'].id, names: ['Ann Able'], source: 'officer', byName: 'Officer' });
  await su.deleteSignup(s.id);
  await db.setSetting('event_signup_open', '1');
});

test('db: one event per person, team size, capacity', skip, async () => {
  const a = await su.createSignup({ eventId: ev['Accounting'].id, names: ['ann able'] });
  assert.deepEqual(a.people.map(p => p.name), ['Ann Able']);
  // Same person, another event (any spelling)
  let e = await err(su.createSignup({ eventId: ev['Economics'].id, names: ['ANN  ABLE'] }));
  assert.match(e.message, /Ann Able is already signed up for Accounting/);
  // ...or as someone's teammate
  e = await err(su.createSignup({ eventId: ev['Marketing'].id, names: ['Ben Bell', 'Ann Able'] }));
  assert.match(e.message, /Ann Able is already signed up for Accounting/);
  assert.equal((await su.listSignups()).length, 1, 'the failed team sign-up saved nothing');
  // Team sizes
  e = await err(su.createSignup({ eventId: ev['Marketing'].id, names: ['A1 X', 'A2 X', 'A3 X', 'A4 X'] }));
  assert.match(e.message, /at most 3/);
  e = await err(su.createSignup({ eventId: ev['Parliamentary Procedure'].id, names: ['P1 X', 'P2 X', 'P3 X'] }));
  assert.match(e.message, /at least 4/);
  e = await err(su.createSignup({ eventId: ev['Accounting'].id, names: ['C1 X', 'C2 X'] }));
  assert.match(e.message, /individual event/);
  e = await err(su.createSignup({ eventId: ev['Marketing'].id, names: ['Dup Person', 'dup person'] }));
  assert.match(e.message, /listed more than once/);
  // Teammates are locked in too
  await su.createSignup({ eventId: ev['Marketing'].id, names: ['Ben Bell', 'Cal Cox', 'Dee Day'] });
  e = await err(su.createSignup({ eventId: ev['Accounting'].id, names: ['Dee Day'] }));
  assert.match(e.message, /Dee Day is already signed up for Marketing/);
  // Capacity: Public Speaking allows 2
  await su.createSignup({ eventId: ev['Public Speaking'].id, names: ['Sp One'] });
  await su.createSignup({ eventId: ev['Public Speaking'].id, names: ['Sp Two'] });
  e = await err(su.createSignup({ eventId: ev['Public Speaking'].id, names: ['Sp Three'] }));
  assert.equal(e.status, 409); assert.match(e.message, /full/);
  // Freeing a spot
  const sp = (await su.listSignups()).find(s => s.event_name === 'Public Speaking');
  await su.deleteSignup(sp.id);
  await su.createSignup({ eventId: ev['Public Speaking'].id, names: ['Sp Three'] });
  // The removed person can sign up again
  await su.createSignup({ eventId: ev['Economics'].id, names: [sp.people[0].name] });
});

test('db: races never over-fill an event or double-book a person', skip, async () => {
  // 10 different people race for Impromptu Speaking's 2 spots.
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => su.createSignup({ eventId: ev['Impromptu Speaking'].id, names: [`Racer ${i}`] })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => /full/.test(r.reason.message)));
  // One person submitted to 6 different events at once.
  const evs = ['Business Law', 'Journalism', 'Cybersecurity', 'Real Estate', 'Agribusiness', 'Advertising'];
  const r2 = await Promise.allSettled(evs.map(n => su.createSignup({ eventId: ev[n].id, names: ['Greedy Gus'] })));
  assert.equal(r2.filter(r => r.status === 'fulfilled').length, 1);
  const gus = (await su.listSignups()).filter(s => s.people.some(p => p.name === 'Greedy Gus'));
  assert.equal(gus.length, 1);
  // Counts stay consistent with the stored sign-ups.
  const list = await su.listEvents();
  for (const e of list) assert.equal(e.taken, (await su.listSignups()).filter(s => s.event_id === e.id).length, e.name);
  assert.ok(list.every(e => e.taken <= e.max_entries));
});

test('db: chapter project on top of one event, and the one-event-total switch', skip, async () => {
  // Ann (Accounting) can also do a chapter project.
  const cp = await su.createSignup({ eventId: ev['Community Service Project'].id, names: ['Ann Able', 'Eve East'] });
  let e = await err(su.createSignup({ eventId: ev['American Enterprise Project'].id, names: ['Eve East'] }));
  assert.match(e.message, /already signed up for Community Service Project.*chapter project/);
  // Only one Community Service Project team per chapter.
  e = await err(su.createSignup({ eventId: ev['Community Service Project'].id, names: ['Fay Fox'] }));
  assert.match(e.message, /full/);
  // Can't switch to one event total while Ann holds two.
  e = await err(su.setOneEventOnly(true));
  assert.match(e.message, /Ann Able is signed up for both/);
  await su.deleteSignup(cp.id);
  await su.setOneEventOnly(true);
  assert.equal((await su.settingsFlags()).strict, true);
  e = await err(su.createSignup({ eventId: ev['Community Service Project'].id, names: ['Ann Able'] }));
  assert.match(e.message, /Ann Able is already signed up for Accounting/);
  const eve = await su.createSignup({ eventId: ev['Community Service Project'].id, names: ['Eve East'] });
  e = await err(su.createSignup({ eventId: ev['Business Law'].id, names: ['Eve East'] }));
  assert.match(e.message, /already signed up for Community Service Project/);
  await su.deleteSignup(eve.id);
  await su.setOneEventOnly(false);
});

test('db: event edits keep existing sign-ups valid', skip, async () => {
  const m = ev['Marketing'];
  let e = await err(su.updateEvent(m.id, { ...m, max_entries: 0 }));
  assert.match(e.message, /from 1 to 50/);
  await su.createSignup({ eventId: m.id, names: ['Gil Gray'] });
  e = await err(su.updateEvent(m.id, { ...m, max_entries: 1 }));
  assert.match(e.message, /can't go below 2/);
  e = await err(su.updateEvent(m.id, { ...m, max_size: 2 }));
  assert.match(e.message, /doesn't fit that team size/);
  e = await err(su.deleteEvent(m.id));
  assert.match(e.message, /has 2 sign-ups/);
  const renamed = await su.updateEvent(m.id, { ...m, name: 'Marketing (renamed)' });
  assert.equal(renamed.name, 'Marketing (renamed)');
  assert.ok((await su.listSignups()).filter(s => s.event_id === m.id).every(s => s.event_name === 'Marketing (renamed)'));
  await su.updateEvent(m.id, { ...m, name: 'Marketing' });
  e = await err(su.addEvent({ name: 'marketing', team: false, max_entries: 3 }));
  assert.match(e.message, /already in the list/);
});

test('db: with a member list, only listed members can sign up', skip, async () => {
  const { rows } = su.parseRosterText('First,Last,Grade\nHal,Hart,11\nIvy,Ink,9\nJon,Jett,10\nAnn,Able,12\nKim,King,9\nKim,Knox,10');
  assert.equal((await su.addRosterMembers(rows, 'Officer')).added, 6);
  assert.deepEqual((await su.addRosterMembers([{ first_name: 'hal', last_name: 'HART' }], 'Officer')).skipped, ['Hal Hart']);
  let e = await err(su.createSignup({ eventId: ev['Business Law'].id, names: ['Not Amember'] }));
  assert.match(e.message, /isn't on the chapter's FBLA member list/);
  assert.equal(e.field, 0);
  // First name only, when unique
  const s = await su.createSignup({ eventId: ev['Business Law'].id, names: ['hal'] });
  assert.deepEqual(s.people.map(p => p.name), ['Hal Hart']);
  e = await err(su.createSignup({ eventId: ev['Sales Presentation'].id, names: ['Ivy Ink', 'kim'] }));
  assert.match(e.message, /More than one member matches "Kim"/); assert.equal(e.field, 1);
  // Grade limit on Introduction events
  e = await err(su.createSignup({ eventId: ev['Introduction to FBLA'].id, names: ['Hal'] }));
  assert.match(e.message, /only for 9th and 10th graders, and Hal Hart is in 11th grade/);
  e = await err(su.createSignup({ eventId: ev['Introduction to Business Presentation'].id, names: ['Ivy Ink', 'Kim King', 'Hal Hart'] }));
  assert.match(e.message, /Hal Hart is in 11th grade/); assert.equal(e.field, 2);
  await su.createSignup({ eventId: ev['Introduction to Business Presentation'].id, names: ['Ivy Ink', 'Kim King', 'Jon Jett'] });
  // Earlier free-typed sign-ups are flagged once the list exists.
  const flagged = (await su.listSignups()).flatMap(x => x.people).filter(p => p.on_roster === false).map(p => p.name);
  assert.ok(flagged.includes('Ben Bell')); assert.ok(!flagged.includes('Ann Able'), 'Ann Able is on the list');
  // checkName gives live feedback
  assert.deepEqual(await su.checkName('kim knox', ev['Accounting'].id), { ok: true, name: 'Kim Knox' });
  assert.match((await su.checkName('Ivy', ev['Accounting'].id)).error, /Ivy Ink is already signed up for Introduction to Business Presentation/);
  // CSV export
  const csv = await su.signupsCsv();
  assert.match(csv, /^"Event","Type","People per entry","Allowed","Signed up","Spots left","Entry #","Person 1"/);
  assert.match(csv, /"Hal Hart"/);
  const lines = csv.split('\r\n');
  assert.ok(lines.some(l => l.startsWith('"Advanced Accounting","Individual","1","3","0","3",""')), 'events with no sign-ups are listed too');
  // Excel: open the file and check the sheets
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await su.signupsXlsx());
  assert.deepEqual(wb.worksheets.map(w => w.name), ['By event', 'Sign-ups', 'People', 'Not signed up yet']);
  const byEvent = wb.getWorksheet('By event');
  const names = new Set(); byEvent.eachRow((r, n) => { if (n > 1) names.add(r.getCell(1).value); });
  assert.equal(names.size, 78, 'every event appears');
  const people = wb.getWorksheet('People');
  const hal = []; people.eachRow((r, n) => { if (r.getCell(1).value === 'Hal Hart') hal.push([r.getCell(2).value, r.getCell(5).value, r.getCell(6).value]); });
  assert.deepEqual(hal, [['Business Law', '11', 'Yes']]);
  const notSigned = []; wb.getWorksheet('Not signed up yet').eachRow((r, n) => { if (n > 1) notSigned.push(`${r.getCell(2).value} ${r.getCell(1).value}`); });
  assert.ok(notSigned.includes('Kim Knox') && !notSigned.includes('Hal Hart'));
});

test('db: grade limit applies when the member list has the grade', skip, async () => {
  await su.addRosterMembers([{ first_name: 'Lou', last_name: 'Lane', grade: '11' }], 'Officer');
  const e = await err(su.createSignup({ eventId: ev['Introduction to FBLA'].id, names: ['Lou Lane'] }));
  assert.match(e.message, /only for 9th and 10th graders, and Lou Lane is in 11th grade/);
});

test('db: sign-up code: officers set it, the site only learns whether one is needed', skip, async () => {
  // Off by default: anything goes.
  assert.equal((await su.settingsFlags()).code_required, false);
  assert.equal(await su.codeAccepted(''), true);
  // Can't turn it on without a code, and codes are 3-40 characters.
  assert.match((await err(su.setSignupCode({ required: true }))).message, /Type a code/);
  assert.match((await err(su.setSignupCode({ required: true, code: 'ab' }))).message, /3 to 40/);
  assert.match((await err(su.setSignupCode({ required: true, code: 'x'.repeat(41) }))).message, /3 to 40/);
  const r = await su.setSignupCode({ required: true, code: '  FBLA  2026 ' });
  assert.deepEqual([r.code_required, r.code, r.changed], [true, 'FBLA 2026', true]);
  // Takes effect immediately (the officer change drops the cached copy).
  assert.equal(await su.codeAccepted(''), false);
  assert.equal(await su.codeAccepted('wrong'), false);
  assert.equal(await su.codeAccepted('FBLA 2026'), true);
  assert.equal(await su.codeAccepted('fbla2026'), true, 'not case-sensitive, spaces ignored');
  // The public state says a code is needed but never what it is.
  const pub = await su.publicSignupState();
  assert.equal(pub.code_required, true);
  assert.ok(!JSON.stringify(pub).toLowerCase().includes('fbla 2026'), 'code never reaches the public state');
  // Changing it: the old one stops working.
  await su.setSignupCode({ code: 'NEWCODE' });
  assert.equal(await su.codeAccepted('fbla2026'), false);
  assert.equal(await su.codeAccepted('newcode'), true);
  // Turning it off keeps the code for next time.
  const off = await su.setSignupCode({ required: false });
  assert.deepEqual([off.code_required, off.code], [false, 'NEWCODE']);
  assert.equal(await su.codeAccepted(''), true);
  assert.equal((await su.publicSignupState()).code_required, false);
});
