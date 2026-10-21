// Buddy System: every member on the FBLA Member List is in one officer's
// buddy group, so each member has an officer to go to. Officers build the
// groups in the officer portal and show or hide the Buddy System page on the
// site (no code, unlike Event Sign-Up).
//
// Collections:
//   buddy_groups       one per officer: { id, officer_id, leader_name, leader_title }
//   buddy_assignments  one per member, _id = the member's roster id, so a
//                      member can only ever be in one group: { roster_id, group_id }
// The leader's name, title and email are read from the officer account when
// shown, so a renamed officer shows up right; leader_name/leader_title are
// kept for a group whose officer account was removed.
const db = require('./db');

const C = { groups: 'buddy_groups', assignments: 'buddy_assignments', roster: 'member_roster' };

class BuddyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function mdb() {
  await db.init();
  const a = db.ensureFirebase();
  return { d: a._db(), client: a._client() };
}

const fullName = (m) => `${m.first_name} ${m.last_name}`.replace(/\s+/g, ' ').trim();
const byLastName = (a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name);

async function isVisible() {
  const s = await db.getSettings();
  return s.buddy_visible === '1';
}
async function setVisible(on) {
  await db.setSetting('buddy_visible', on ? '1' : '0');
  return { visible: !!on };
}

// Everything the officer tab needs: the groups with their members, who still
// needs a buddy, and the officers who could lead a group.
async function overview() {
  const { d } = await mdb();
  const [groups, assignments, roster, team, visible] = await Promise.all([
    d.collection(C.groups).find({}).toArray(),
    d.collection(C.assignments).find({}).toArray(),
    d.collection(C.roster).find({}).toArray(),
    db.leadershipTeam(),
    isVisible(),
  ]);
  const people = new Map(roster.map(m => [m.id, m]));
  const rank = new Map(team.map((o, i) => [o.id, i]));
  const officerOf = new Map(team.map(o => [o.id, o]));
  const groupOf = new Map();
  assignments.forEach(a => { if (people.has(a.roster_id)) groupOf.set(a.roster_id, a.group_id); });
  const member = (m) => ({ roster_id: m.id, name: fullName(m), first_name: m.first_name, last_name: m.last_name, grade: m.grade || null });
  const out = groups.map(({ _id, ...g }) => {
    const o = officerOf.get(g.officer_id);
    return {
      id: g.id, officer_id: g.officer_id,
      leader_name: o ? o.name : g.leader_name,
      leader_title: o ? o.display_title : (g.leader_title || null),
      leader_email: o ? o.email || null : null,
      officer_active: !!o,
      members: roster.filter(m => groupOf.get(m.id) === g.id).sort(byLastName).map(member),
    };
  }).sort((a, b) => (rank.has(a.officer_id) ? rank.get(a.officer_id) : 999) - (rank.has(b.officer_id) ? rank.get(b.officer_id) : 999)
    || a.leader_name.localeCompare(b.leader_name));
  const taken = new Set(groups.map(g => g.officer_id));
  return {
    visible,
    groups: out,
    roster_count: roster.length,
    unassigned: roster.filter(m => !groupOf.has(m.id)).sort(byLastName).map(member),
    officers: team.map(o => ({ id: o.id, name: o.name, title: o.display_title, has_group: taken.has(o.id) })),
  };
}

async function addGroup(officerId, byName) {
  const { d } = await mdb();
  const o = (await db.leadershipTeam()).find(x => x.id === Number(officerId));
  if (!o) throw new BuddyError('Pick an officer to lead the group.');
  if (await d.collection(C.groups).findOne({ officer_id: o.id })) throw new BuddyError(`${o.name} already has a buddy group.`);
  const id = await db.nextId('buddy_groups');
  const doc = { _id: String(id), id, officer_id: o.id, leader_name: o.name, leader_title: o.display_title, created_by: byName || null, created_at: db.tsString() };
  try {
    await d.collection(C.groups).insertOne(doc);
  } catch (e) {
    if (e && e.code === 11000) throw new BuddyError(`${o.name} already has a buddy group.`);
    throw e;
  }
  return doc;
}

// Deleting a group frees its members (they show up as needing a buddy again).
async function deleteGroup(id) {
  const { d, client } = await mdb();
  const session = client.startSession();
  let removed = null, freed = 0;
  try {
    await session.withTransaction(async () => {
      removed = await d.collection(C.groups).findOneAndDelete({ _id: String(Number(id)) }, { session });
      if (!removed) throw new BuddyError('That group is already gone. Refresh the page.', 404);
      freed = (await d.collection(C.assignments).deleteMany({ group_id: removed.id }, { session })).deletedCount;
    });
  } finally { await session.endSession(); }
  return { leader_name: removed.leader_name, freed };
}

// Put members in a group (moving them from any other group), or take them
// out of their group with groupId null.
async function assign(rosterIds, groupId) {
  const { d } = await mdb();
  const ids = [...new Set((Array.isArray(rosterIds) ? rosterIds : [rosterIds]).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new BuddyError('Pick at least one member.');
  const found = await d.collection(C.roster).find({ id: { $in: ids } }).project({ id: 1 }).toArray();
  if (found.length !== ids.length) throw new BuddyError('Someone in that list is no longer on the member list. Refresh the page.', 404);
  if (groupId === null || groupId === undefined || groupId === '') {
    await d.collection(C.assignments).deleteMany({ _id: { $in: ids.map(String) } });
    return { moved: ids.length, group: null };
  }
  const g = await d.collection(C.groups).findOne({ _id: String(Number(groupId)) });
  if (!g) throw new BuddyError('That group is gone. Refresh the page.', 404);
  const now = db.tsString();
  await d.collection(C.assignments).bulkWrite(ids.map(id => ({
    updateOne: { filter: { _id: String(id) }, update: { $set: { roster_id: id, group_id: g.id, assigned_at: now } }, upsert: true },
  })), { ordered: false });
  return { moved: ids.length, group: g };
}

// Give everyone who doesn't have a buddy yet a group, keeping the groups as
// even as possible: each member (in last-name order) goes to whichever group
// is smallest at that moment.
async function assignRest() {
  const { d } = await mdb();
  const o = await overview();
  if (!o.groups.length) throw new BuddyError('Add a buddy group first.');
  if (!o.unassigned.length) return { assigned: 0 };
  const sizes = o.groups.map(g => ({ id: g.id, n: g.members.length }));
  const now = db.tsString();
  const ops = o.unassigned.map(m => {
    const g = sizes.reduce((min, x) => (x.n < min.n ? x : min), sizes[0]);
    g.n++;
    return { updateOne: { filter: { _id: String(m.roster_id) }, update: { $set: { roster_id: m.roster_id, group_id: g.id, assigned_at: now } }, upsert: true } };
  });
  await d.collection(C.assignments).bulkWrite(ops, { ordered: false });
  return { assigned: ops.length };
}

// What the public site shows (only while visible): each group's leader and
// member names. No ids or grades.
async function publicBuddy() {
  if (!(await isVisible())) return null;
  const o = await overview();
  return {
    groups: o.groups.map(g => ({
      id: g.id, leader_name: g.leader_name, leader_title: g.leader_title, leader_email: g.leader_email,
      members: g.members.map(m => m.name),
    })),
  };
}

module.exports = { BuddyError, isVisible, setVisible, overview, addGroup, deleteGroup, assign, assignRest, publicBuddy, COLLECTIONS: C };
