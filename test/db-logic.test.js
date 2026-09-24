const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

test('parseIcs reads multi-day spans from DTEND', () => {
  const { parseIcs } = require('../ics-import');
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:allday@t', 'SUMMARY:States in Hershey',
    'DTSTART;VALUE=DATE:20270412', 'DTEND;VALUE=DATE:20270415', 'END:VEVENT',
    // All-day DTEND is exclusive: Apr 12-15 exclusive = through Apr 14.
    'BEGIN:VEVENT', 'UID:single@t', 'SUMMARY:One day',
    'DTSTART;VALUE=DATE:20270501', 'DTEND;VALUE=DATE:20270502', 'END:VEVENT',
    // Exclusive DTEND one day later = a single-day event, no end_date.
    'BEGIN:VEVENT', 'UID:timed@t', 'SUMMARY:Overnight lock-in',
    'DTSTART:20270520T180000Z', 'DTEND:20270521T090000Z', 'END:VEVENT',
    // Timed DTEND is the real end moment; its date is used as-is.
    'END:VCALENDAR',
  ].join('\r\n');
  const events = parseIcs(ics);
  const byUid = Object.fromEntries(events.map(e => [e.uid, e]));
  assert.equal(byUid['allday@t'].date, '2027-04-12');
  assert.equal(byUid['allday@t'].end_date, '2027-04-14', 'exclusive all-day DTEND loses a day');
  assert.equal(byUid['single@t'].end_date, null, 'single all-day event has no span');
  assert.equal(byUid['timed@t'].date, '2027-05-20');
  assert.equal(byUid['timed@t'].end_date, '2027-05-21', 'timed DTEND date kept as-is');
});

test('parseIcs keeps the LOCATION of a Google Calendar event', () => {
  const { parseIcs } = require('../ics-import');
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:loc@t', 'SUMMARY:Chapter meeting', 'LOCATION:LGI B229\\, State High',
    'DTSTART:20261001T080000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:noloc@t', 'SUMMARY:No room yet', 'DTSTART;VALUE=DATE:20261002', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const byUid = Object.fromEntries(parseIcs(ics).map(e => [e.uid, e]));
  assert.equal(byUid['loc@t'].location, 'LGI B229, State High');
  assert.equal(byUid['loc@t'].time, '08:00');
  assert.equal(byUid['noloc@t'].location, null);
});

// ----- public hub helpers -----

test('countdowns show enabled, upcoming events once their start date arrives', () => {
  const events = [
    { id: 1, name: 'Regionals', date: '2026-11-14', time: '08:30', countdown_enabled: 1 },
    { id: 2, name: 'No countdown', date: '2026-11-20', countdown_enabled: 0 },
    { id: 3, name: 'Already over', date: '2026-09-01', countdown_enabled: 1 },
    { id: 4, name: 'Starts later', date: '2027-03-01', countdown_enabled: 1, countdown_start: '2027-01-01' },
    { id: 5, name: 'States', date: '2026-10-30', countdown_enabled: 1, countdown_time: '07:00', time: '09:00', location: 'Hershey' },
  ];
  const list = db.activeCountdowns(events, '2026-09-23');
  assert.deepEqual(list.map(c => c.id), [5, 1], 'only active ones, soonest first');
  assert.equal(list[0].time, '07:00', 'the countdown time wins over the start time');
  assert.equal(list[1].time, '08:30', 'falls back to the event start time');
  assert.equal(list[0].location, 'Hershey');
});

test('an event is still counted down on its own day', () => {
  const list = db.activeCountdowns([{ id: 1, name: 'Today', date: '2026-09-23', countdown_enabled: 1 }], '2026-09-23');
  assert.equal(list.length, 1);
});

test('the competitive-event list falls back to the standard list', () => {
  assert.deepEqual(db.competitiveEvents({}), [...db.DEFAULT_COMPETITIVE_EVENTS]);
  assert.deepEqual(db.competitiveEvents({ competitive_events: '' }), [...db.DEFAULT_COMPETITIVE_EVENTS]);
  assert.deepEqual(db.competitiveEvents({ competitive_events: 'not json' }), [...db.DEFAULT_COMPETITIVE_EVENTS]);
  assert.deepEqual(db.competitiveEvents({ competitive_events: '[]' }), [...db.DEFAULT_COMPETITIVE_EVENTS]);
  assert.deepEqual(db.competitiveEvents({ competitive_events: JSON.stringify([' Website Design ', '', 'Personal Finance']) }), ['Website Design', 'Personal Finance']);
});

test('the public config carries display settings only', () => {
  const cfg = db.publicConfig({
    chapter_name: 'State High FBLA', starting_balance: '3320.97', officer_login_strict: '1',
    google_calendar_ical_url: 'https://calendar.google.com/secret.ics', password_reset_email_enabled: '1',
    home_card_title: 'Hi',
  });
  assert.equal(cfg.chapter_name, 'State High FBLA');
  assert.equal(cfg.home_card_title, 'Hi');
  assert.ok(!('competitive_events' in cfg), 'the hub no longer needs the event list');
  for (const privateKey of ['starting_balance', 'officer_login_strict', 'google_calendar_ical_url', 'password_reset_email_enabled']) {
    assert.ok(!(privateKey in cfg), `${privateKey} must not reach the public hub`);
  }
});

test('emailed reset codes are off unless explicitly switched on', () => {
  assert.equal(db.passwordResetEmailEnabled({}), false);
  assert.equal(db.passwordResetEmailEnabled({ password_reset_email_enabled: '0' }), false);
  assert.equal(db.passwordResetEmailEnabled({ password_reset_email_enabled: '1' }), true);
});

test('no student collections are backed up', () => {
  for (const name of ['members', 'event_attendees', 'point_ledger', 'attendance_records', 'form_responses', 'notifications', 'messages', 'forum_posts', 'buddy_members']) {
    assert.ok(!db.BACKUP_COLLECTIONS.includes(name), `${name} should not exist in V2`);
  }
  assert.ok(db.BACKUP_COLLECTIONS.includes('google_forms'));
});

test('parseIcs converts Google\'s UTC times to the calendar\'s time zone', () => {
  const { parseIcs } = require('../ics-import');
  const ics = [
    'BEGIN:VCALENDAR', 'X-WR-TIMEZONE:America/New_York',
    // 12:00 UTC in October = 8:00 AM Eastern (daylight time).
    'BEGIN:VEVENT', 'UID:fall@t', 'SUMMARY:FBLA Meeting', 'DTSTART:20261022T120000Z', 'DTEND:20261022T123000Z', 'END:VEVENT',
    // 13:00 UTC in December = 8:00 AM Eastern (standard time).
    'BEGIN:VEVENT', 'UID:winter@t', 'SUMMARY:FBLA Meeting', 'DTSTART:20261210T130000Z', 'END:VEVENT',
    // 01:30 UTC on Oct 7 is still Oct 6 in New York.
    'BEGIN:VEVENT', 'UID:late@t', 'SUMMARY:Evening prep', 'DTSTART:20261007T013000Z', 'END:VEVENT',
    // A TZID time is already local, so it is read as written.
    'BEGIN:VEVENT', 'UID:tzid@t', 'SUMMARY:Local', 'DTSTART;TZID=America/New_York:20261015T154500', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const byUid = Object.fromEntries(parseIcs(ics).map(e => [e.uid, e]));
  assert.deepEqual([byUid['fall@t'].date, byUid['fall@t'].time], ['2026-10-22', '08:00']);
  assert.deepEqual([byUid['winter@t'].date, byUid['winter@t'].time], ['2026-12-10', '08:00']);
  assert.deepEqual([byUid['late@t'].date, byUid['late@t'].time], ['2026-10-06', '21:30']);
  assert.deepEqual([byUid['tzid@t'].date, byUid['tzid@t'].time], ['2026-10-15', '15:45']);
});

test('the home card queue keeps only valid calendar refs, in order', () => {
  assert.deepEqual(db.homeCardQueue(['custom:29', 'pay1:3', 'custom:29', 'bogus', 'event:x', ' event:4 ']), ['custom:29', 'pay1:3', 'event:4']);
  assert.deepEqual(db.homeCardQueue('["custom:1","custom:2"]'), ['custom:1', 'custom:2']);
  assert.deepEqual(db.homeCardQueue('not json'), []);
  assert.deepEqual(db.homeCardQueue(undefined), []);
  assert.deepEqual(db.publicConfig({ home_card_queue: '["custom:7"]' }).home_card_queue, ['custom:7']);
});
