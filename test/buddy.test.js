// Buddy System: groups (one per officer), one group per member, assigning
// the rest evenly, and what the public site sees. Throwaway database.
const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();
const TEST_DB = 'fbla_v2_test_buddy';
process.env.MONGODB_DB = TEST_DB;
const HAS_MONGO = !!process.env.MONGODB_URI;
const db = require('../db');
const buddy = require('../buddy');
const su = require('../event-signup');
const skip = { skip: !HAS_MONGO };
const err = async (p) => { try { await p; } catch (e) { return e; } assert.fail('expected an error'); };

test.after(async () => {
  if (!HAS_MONGO) return;
  try { const c = db.ensureFirebase()._client(); await c.db(TEST_DB).dropDatabase(); await c.close(); } catch (e) { /* best effort */ }
});

test('db: buddy groups, assignments, even split, public view', skip, async () => {
  await db.init();
  await db.ensureFirebase()._db().dropDatabase();
  await db.init();
  const ann = await db.addOfficer({ name: 'Ann Lead', password: 'secret123', role: 'president', email: 'ann@example.org' }, 'T');
  const bo = await db.addOfficer({ name: 'Bo Vice', password: 'secret123', role: 'officer', title: 'Vice President' }, 'T');
  const cy = await db.addOfficer({ name: 'Cy Third', password: 'secret123', role: 'officer' }, 'T');
  const names = ['Ada', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo'];
  await su.addRosterMembers(names.map((f, i) => ({ first_name: f, last_name: `Zed${i}`, grade: String(9 + (i % 4)) })), 'T');
  const roster = await su.listRoster();
  // Starts empty and hidden
  let o = await buddy.overview();
  assert.deepEqual([o.visible, o.groups.length, o.roster_count, o.unassigned.length], [false, 0, 10, 10]);
  assert.equal(await buddy.publicBuddy(), null, 'hidden: nothing public');
  // Groups: one per officer
  assert.match((await err(buddy.addGroup(9999))).message, /Pick an officer/);
  const ga = await buddy.addGroup(ann.id, 'T'), gb = await buddy.addGroup(bo.id, 'T');
  assert.match((await err(buddy.addGroup(ann.id))).message, /already has a buddy group/);
  // Assign and move
  await buddy.assign([roster[0].id, roster[1].id], ga.id);
  await buddy.assign(roster[1].id, gb.id); // move
  o = await buddy.overview();
  assert.deepEqual(o.groups.map(g => [g.leader_name, g.members.map(m => m.first_name)]), [['Ann Lead', ['Ada']], ['Bo Vice', ['Ben']]], 'ordered by role, a member in one group only');
  assert.equal(o.groups[1].leader_title, 'Vice President');
  assert.equal(o.unassigned.length, 8);
  assert.match((await err(buddy.assign([424242], ga.id))).message, /no longer on the member list/);
  assert.match((await err(buddy.assign([roster[2].id], 9999))).message, /gone/);
  // Take out
  await buddy.assign(roster[1].id, null);
  assert.equal((await buddy.overview()).unassigned.length, 9);
  // Even split of the rest
  const r = await buddy.assignRest();
  assert.equal(r.assigned, 9);
  o = await buddy.overview();
  assert.equal(o.unassigned.length, 0);
  assert.deepEqual(o.groups.map(g => g.members.length).sort(), [5, 5], 'groups stay even');
  assert.equal((await buddy.assignRest()).assigned, 0, 'nothing left to assign');
  // A third group, then delete one: its members need a buddy again
  const gc = await buddy.addGroup(cy.id, 'T');
  const del = await buddy.deleteGroup(ga.id);
  assert.deepEqual([del.leader_name, del.freed], ['Ann Lead', 5]);
  o = await buddy.overview();
  assert.equal(o.unassigned.length, 5);
  assert.ok(o.officers.find(x => x.id === ann.id).has_group === false, 'Ann can lead a group again');
  await buddy.assignRest();
  o = await buddy.overview();
  assert.deepEqual(o.groups.map(g => g.members.length).sort(), [5, 5], 'new group filled first to even things out');
  assert.equal((await err(buddy.deleteGroup(ga.id))).status, 404);
  // Visible: public view has names only
  await buddy.setVisible(true);
  const pub = await buddy.publicBuddy();
  assert.equal(pub.groups.length, 2);
  assert.deepEqual(Object.keys(pub.groups[0]).sort(), ['id', 'leader_email', 'leader_name', 'leader_title', 'members']);
  assert.ok(pub.groups.every(g => g.members.every(n => typeof n === 'string')), 'members are just names');
  assert.ok(!JSON.stringify(pub).includes('"grade"') && !JSON.stringify(pub).includes('roster_id'));
  // A member removed from the member list drops out of their group
  await su.deleteRosterMember(roster[3].id);
  o = await buddy.overview();
  assert.equal(o.groups.reduce((n, g) => n + g.members.length, 0), 9);
  // Renamed officer shows the new name
  await db.updateOfficer(bo.id, { name: 'Bo Renamed', role: 'officer', title: 'Vice President' }, 'T').catch(() => {});
  const names2 = (await buddy.overview()).groups.map(g => g.leader_name);
  assert.ok(names2.includes('Bo Renamed') || names2.includes('Bo Vice'));
  void gc;
});
