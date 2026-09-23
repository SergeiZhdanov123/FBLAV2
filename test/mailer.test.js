// Unit tests for the email logic: server-side recipient resolution (the
// officer team is the only audience in V2) and the compose guards. Everything
// runs against plain objects, so no database and no mail transport is touched.
const test = require('node:test');
const assert = require('node:assert');
const mailer = require('../mailer');

const fakeDb = {
  listOfficers: async () => ([
    { id: 10, name: 'Dee Officer', email: 'dee@example.com', active: 1 },
    { id: 11, name: 'Old Officer', email: 'old@example.com', active: 0 },
    { id: 12, name: 'No Email', email: null, active: 1 },
    { id: 13, name: 'Dee Twin Record', email: 'DEE@example.com', active: 1 },
  ]),
};
const emails = (list) => list.map(r => r.email).sort();

test('the officer team is every active officer with an email', async () => {
  const r = await mailer.resolveRecipients(fakeDb, { mode: 'officers' });
  assert.deepEqual(emails(r), ['DEE@example.com', 'dee@example.com']);
});

test('the default audience is the officer team', async () => {
  const r = await mailer.resolveRecipients(fakeDb, {});
  assert.equal(r.length, 2);
});

test('any student-facing audience is rejected (there are no student accounts)', async () => {
  for (const mode of ['all', 'members', 'unpaid', 'event', 'committee']) {
    await assert.rejects(() => mailer.resolveRecipients(fakeDb, { mode }), /officer team/);
  }
});

test('one address gets one copy, whatever case it is written in', () => {
  const deduped = mailer.dedupeRecipients([
    { name: 'Dee', email: 'dee@example.com' },
    { name: 'Dee Officer', email: 'DEE@example.com' },
    { name: 'Blank', email: '' },
    { name: 'Ada', email: 'ada@example.com' },
  ]);
  assert.deepEqual(emails(deduped), ['ada@example.com', 'dee@example.com']);
});

test('compose preview resolves the audience without sending', async () => {
  const r = await mailer.sendCustomEmail(fakeDb, { mode: 'officers', preview: true, subject: '', body: '' });
  assert.equal(r.preview, true);
  assert.equal(r.total, 1, 'the two Dee records share one inbox');
});

test('compose refuses an empty subject or body', async () => {
  // With no credentials the "not set up" guard fires first, so configure a
  // dummy transport to reach the subject/body validation underneath it.
  const had = process.env.ResendAPI;
  process.env.ResendAPI = 'test-key-not-used';
  try {
    await assert.rejects(() => mailer.sendCustomEmail(fakeDb, { mode: 'officers', subject: '', body: 'hi' }), /subject/);
    await assert.rejects(() => mailer.sendCustomEmail(fakeDb, { mode: 'officers', subject: 'Hi', body: '  ' }), /message/);
  } finally {
    if (had === undefined) delete process.env.ResendAPI; else process.env.ResendAPI = had;
  }
});

test('compose refuses to send when email is not configured', async () => {
  const had = process.env.ResendAPI;
  delete process.env.ResendAPI;
  try {
    await assert.rejects(() => mailer.sendCustomEmail(fakeDb, { mode: 'officers', subject: 'Hi', body: 'There' }), /not set up/);
  } finally {
    if (had !== undefined) process.env.ResendAPI = had;
  }
});

test('email status reports only the transport, never credentials', () => {
  const s = mailer.status();
  assert.deepEqual(Object.keys(s).sort(), ['configured', 'from', 'transport']);
});
