const test = require('node:test');
const assert = require('node:assert/strict');
const { QUESTIONS, EVENTS, recommend } = require('../public/event-quiz.js');
const db = require('../db');

const base = { grade: '10', q1: 'none', q2: '1', q3: '1', q4: '1', q5: 'mix', q6: '1', q7: '0', q8: '0', q9: '0', q10: '1', q11: 'other', q12: 'read', q13: 'focused', q14: '1', q15: 'open', q16: '2.5', q17: 'organization', q18: 'unsure' };

test('the quiz asks grade plus the 18 chapter questions, every option has a value', () => {
  assert.equal(QUESTIONS.length, 19);
  assert.equal(QUESTIONS[0].id, 'grade');
  for (const q of QUESTIONS) {
    assert.ok(q.options.length >= 2, q.id);
    assert.equal(new Set(q.options.map(o => o[0])).size, q.options.length, `${q.id} values are unique`);
  }
});

test('the event table covers the 78 competitive events with valid formats', () => {
  assert.equal(EVENTS.length, 78);
  assert.equal(new Set(EVENTS.map(e => e.name)).size, 78);
  const formats = ['test', 'production', 'roleplay', 'presentation', 'speech', 'impromptu', 'interview', 'chapter'];
  for (const e of EVENTS) {
    assert.ok(formats.includes(e.fmt), e.name);
    assert.ok(['i', 't3', 't45'].includes(e.team), e.name);
    assert.ok(e.desc && e.desc.startsWith(e.name.split(' ')[0]), `${e.name} has its guide description`);
    assert.ok(e.prep >= 1 && e.prep <= 3, e.name);
  }
  assert.equal(EVENTS.filter(e => e.intro).length, 13, 'thirteen Introduction events (9th/10th only)');
  assert.ok(EVENTS.filter(e => e.intro).every(e => e.name.startsWith('Introduction to')));
});

test('11th and 12th graders are never recommended Introduction events', () => {
  for (const grade of ['11', '12']) {
    assert.ok(!recommend({ ...base, grade }).some(r => r.event.intro), grade);
  }
  assert.ok(recommend({ ...base, grade: '9' }).some(r => r.event.intro));
});

test('recommendations follow the answers', () => {
  const shyFinance = recommend({ ...base, grade: '12', q1: 'alone', q2: '-2', q3: '-2', q4: '-2', q8: '-1.5', q14: '-2', q6: '2', q9: '2', q11: 'finance', q15: 'test', q16: '1' });
  assert.ok(shyFinance.slice(0, 5).every(r => r.event.fmt === 'test' && r.event.areas.includes('finance')), 'shy finance student gets finance tests');
  const speaker = recommend({ ...base, grade: '11', q1: 'alone', q2: '2', q3: '2', q8: '2', q14: '2', q6: '-2', q15: 'present', q17: 'communication', q18: 'speaking' });
  assert.ok(speaker.slice(0, 3).some(r => r.event.name === 'Public Speaking'), 'a confident speaker sees Public Speaking');
  assert.ok(!speaker.slice(0, 5).some(r => r.event.fmt === 'test'), 'someone avoiding tests is not given test-only events');
  const health = recommend({ ...base, q11: 'healthcare' });
  assert.equal(health[0].event.name, 'Healthcare Administration');
  const loner = recommend({ ...base, q1: 'alone' });
  assert.ok(!loner.slice(0, 10).some(r => r.event.team === 't45'), 'no team-of-5 events for someone who works alone');
  const top = recommend(base)[0];
  assert.ok(top.reasons.length >= 1 && top.reasons.length <= 3);
});

test('the quiz is hidden from the hub until an officer turns it on', () => {
  assert.equal(db.publicConfig({}).event_quiz_visible, false);
  assert.equal(db.publicConfig({ event_quiz_visible: '0' }).event_quiz_visible, false);
  assert.equal(db.publicConfig({ event_quiz_visible: '1' }).event_quiz_visible, true);
});
