// Points from the Google Sheet. No database and no Google: both are stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPointsSync, parsePointsRows, matchRoster, topTen } = require('../points-sheet');

// Same comparison form as event-signup's normName (copied so this test never loads the DB code).
const normName = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const HEAD = ['Member Name', 'Attendance \n(Regularaly Updated)', 'Point System Updates', 'Total Points', '', '', 'Rankings ->', 'Member Name', 'Attendance', 'Point System Updates', 'Total Points'];

test('reads the left Member Name / Total Points columns, blank and "-" are 0', () => {
  const { rows, problems } = parsePointsRows([
    HEAD,
    ['Joseph Janik', 2, 3, 5, '', '', '', 'Max Cooper', 12, 56, 68],
    ['Dylan Miller', 0, '', '', '', '', '', 'Bianca Canepari', 12, 51, 63],
    ['Zoe Yan', 4, '', '-'],
    ['', '', '', ''],
    ['Bad Row', 1, 1, 'lots'],
  ]);
  assert.deepEqual(rows, [{ name: 'Joseph Janik', total: 5 }, { name: 'Dylan Miller', total: 0 }, { name: 'Zoe Yan', total: 0 }]);
  assert.equal(problems.length, 1);
});

test('a tab without the columns is refused', () => {
  assert.throws(() => parsePointsRows([['Name', 'Score'], ['A B', 1]]), /Member Name/);
});

test('matches full names, short-name second entries follow, unknown names are skipped', () => {
  const roster = [
    { id: 1, first_name: 'Sophia Maria', last_name: 'Kantor', points: 3 },
    { id: 2, first_name: 'Sophia', last_name: 'Kantor', points: 3 },
    { id: 3, first_name: 'Robert', preferred_name: 'Bobby', last_name: 'Smith', points: null },
    { id: 4, first_name: 'Amy', last_name: 'Wong', points: 9 },
  ];
  const m = matchRoster([
    { name: 'Sophia Maria Kantor', total: 10 },
    { name: 'Bobby Smith', total: 4 },
    { name: 'Nobody Here', total: 50 },
  ], roster, normName);
  assert.equal(m.assigned.get(1), 10);
  assert.equal(m.assigned.get(2), 10);
  assert.equal(m.assigned.get(3), 4);
  assert.equal(m.assigned.has(4), false); // not in the sheet: left alone
  assert.deepEqual(m.unmatched, ['Nobody Here']);
});

test('top 10 leaves officers out and shows a doubled member once', () => {
  const roster = [
    { id: 1, first_name: 'Sophia Maria', last_name: 'Kantor', points: 10 },
    { id: 2, first_name: 'Sophia', last_name: 'Kantor', points: 10 },
    { id: 3, first_name: 'Olive', last_name: 'Officer', points: 99 },
    { id: 4, first_name: 'Amy', last_name: 'Wong', points: 9 },
  ];
  assert.deepEqual(topTen(roster, new Set(['olive officer']), normName), [
    { name: 'Sophia Kantor', points: 10 },
    { name: 'Amy Wong', points: 9 },
  ]);
});

function stubWorld(sheetValues) {
  const settings = { points_sheet: JSON.stringify({ sheet_id: '1HTRyEPT8FEmJYdRNITKJ897cFL4Mk7A9YGnv2Dj5aWs', tab: 'Points', enabled: true }) };
  const roster = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, first_name: `First${String.fromCharCode(65 + i)}`, last_name: `Last${String.fromCharCode(65 + i)}`, points: 1 }));
  const writes = [];
  const db = {
    getSettings: async () => ({ ...settings }),
    setSetting: async (k, v) => { settings[k] = v; writes.push(k); },
    logAudit: async () => {},
    pointsPage: (v) => { const o = typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}); return { intro: '', form_url: '', pdf_url: '', leaderboard: o.leaderboard || [], updated_at: o.updated_at || '' }; },
  };
  const saved = [];
  const signup = {
    normName,
    listRoster: async () => roster.map(r => ({ ...r })),
    setRosterPoints: async (list) => { saved.push(...list); list.forEach(u => { roster.find(r => r.id === u.id).points = u.points; }); return { saved: list.length }; },
  };
  const sync = createPointsSync({ db, signup, officerNames: async () => new Set(), fetchRows: async () => sheetValues(), now: () => new Date('2026-11-26T15:00:00Z') });
  return { sync, settings, saved, writes };
}

test('sync updates changed members and the board, then does nothing when the sheet is the same', async () => {
  const values = () => [HEAD, ...Array.from({ length: 12 }, (_, i) => [`First${String.fromCharCode(65 + i)} Last${String.fromCharCode(65 + i)}`, 0, 0, i === 0 ? 40 : 1])];
  const w = stubWorld(values);
  const r = await w.sync.syncNow('test');
  assert.equal(r.ok, true);
  assert.deepEqual(w.saved, [{ id: 1, points: 40 }]);
  const page = JSON.parse(w.settings.points_page);
  assert.equal(page.updated_at, '2026-11-26');
  assert.deepEqual(page.leaderboard[0], { name: 'FirstA LastA', points: 40 });
  w.writes.length = 0;
  const again = await w.sync.syncNow('test');
  assert.equal(again.changed, false);
  assert.deepEqual(w.writes, ['points_sheet_status']); // board date left alone
});

test('a sheet that looks wrong changes nothing', async () => {
  const w = stubWorld(() => [HEAD, ['Only One', 0, 0, 5]]);
  const r = await w.sync.syncNow('test');
  assert.equal(r.ok, false);
  assert.match(r.error, /looks wrong/);
  assert.equal(w.saved.length, 0);
  assert.equal(w.settings.points_page, undefined);
});

test('automatic checks wait 10 minutes between reads', async () => {
  let reads = 0;
  const w = stubWorld(() => { reads++; return [HEAD, ...Array.from({ length: 12 }, (_, i) => [`First${String.fromCharCode(65 + i)} Last${String.fromCharCode(65 + i)}`, 0, 0, 1])]; });
  await w.sync.maybeSync();
  await w.sync.maybeSync();
  assert.equal(reads, 1);
});
