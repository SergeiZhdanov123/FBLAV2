// Resets both MongoDB and the Google Sheets recovery workbook.
//
// Usage:
//   node reset-db.js           # asks for confirmation (type RESET)
//   node reset-db.js --yes     # skip the prompt (for scripts/CI)
//   npm run reset              # same as `node reset-db.js`
//   npm run reset:databases    # explicit alias
//
// Uses the MongoDB and Google Sheets credentials configured in .env.
//
// Deletes every document from every MongoDB collection used by the app,
// re-seeds the $3,320.97 starting balance, and rewrites every managed Google
// worksheet from that clean database snapshot.
//
// Make sure the server is stopped before running this (or be ready for any
// in-flight requests to see partial state).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dbModule = require('./db');
const { createGoogleSheetsBackup, parseSpreadsheetId } = require('./google-sheets-backup');

const COLLECTIONS = dbModule.BACKUP_COLLECTIONS;
const STARTING_BALANCE = '3320.97';

function projectLabel() {
  // Show the MongoDB database + cluster host without leaking credentials.
  try {
    const uri = process.env.MONGODB_URI;
    if (uri) {
      const host = (uri.match(/@([^/?]+)/) || [])[1] || 'cluster';
      return `${process.env.MONGODB_DB || 'fbla_v2'} @ ${host}`;
    }
  } catch (e) { /* ignore */ }
  return 'configured MongoDB database';
}

function spreadsheetLabel() {
  const id = parseSpreadsheetId(process.env.GOOGLE_SHEETS_BACKUP_ID);
  return id ? `https://docs.google.com/spreadsheets/d/${id}` : 'not configured';
}

async function deleteCollection(db, name) {
  const BATCH = 300;
  while (true) {
    const snap = await db.collection(name).limit(BATCH).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < BATCH) break;
  }
}

function assertCleanSnapshot(snapshot) {
  const tables = snapshot && snapshot.tables;
  if (!tables) throw new Error('The clean database verification snapshot is missing its tables');
  const unexpected = [];
  for (const collection of COLLECTIONS) {
    const rows = Array.isArray(tables[collection]) ? tables[collection] : [];
    const expected = collection === 'settings' ? 1 : 0;
    if (rows.length !== expected) unexpected.push(`${collection}: expected ${expected}, found ${rows.length}`);
  }
  const settings = tables.settings || [];
  const startingBalance = settings.find(row => row._document_id === 'starting_balance');
  if (!startingBalance || String(startingBalance.value) !== STARTING_BALANCE) {
    unexpected.push(`settings: starting_balance must equal ${STARTING_BALANCE}`);
  }
  if (unexpected.length) throw new Error(`The database did not reach the expected clean state: ${unexpected.join('; ')}`);
  return true;
}

function assertSheetsMatchSnapshot(status, snapshot) {
  if (!status || status.state !== 'ready') {
    const detail = status && status.lastError ? status.lastError : `state=${status && status.state}`;
    throw new Error(`Google Sheets reset failed: ${detail}`);
  }
  const mismatches = [];
  for (const collection of COLLECTIONS) {
    const expected = snapshot.tables[collection].length;
    const actual = status.rowCounts && status.rowCounts[collection];
    if (actual !== expected) mismatches.push(`${collection}: expected ${expected}, synced ${actual}`);
  }
  if (mismatches.length) throw new Error(`Google Sheets row counts do not match the database: ${mismatches.join('; ')}`);
  return true;
}

async function requireSheetsSync(sheetsBackup, reason, attempts = 1) {
  let status = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    status = await sheetsBackup.requestSync(reason);
    if (status && status.state === 'ready') return status;
  }
  const detail = status && status.lastError ? status.lastError : `state=${status && status.state}`;
  throw new Error(`Google Sheets ${reason} failed: ${detail}`);
}

async function resetDatabases({ database = dbModule, sheetsBackup } = {}) {
  const backup = sheetsBackup || createGoogleSheetsBackup({ snapshotProvider: () => database.backupJson() });

  // Confirm both services and preserve one last current snapshot before any
  // destructive work begins. If this fails, the database is left untouched.
  await requireSheetsSync(backup, 'pre-reset access check');

  const firestore = database.ensureFirebase();
  // Resource cover images are kept out of the backups (too big for Sheets
  // cells) but still have to be cleared.
  for (const collection of [...COLLECTIONS, 'resource_covers']) {
    await deleteCollection(firestore, collection);
  }
  await firestore.collection('settings').doc('starting_balance').set({
    key: 'starting_balance',
    value: STARTING_BALANCE,
  });

  const snapshot = await database.backupJson();
  assertCleanSnapshot(snapshot);

  // Retry the final rewrite because the database is already clean at this point.
  // A persistent failure exits nonzero and leaves the pre-reset Sheet snapshot
  // available for recovery instead of silently claiming the reset succeeded.
  const status = await requireSheetsSync(backup, 'database reset', 3);
  assertSheetsMatchSnapshot(status, snapshot);
  return { snapshot, status };
}

async function main() {
  const project = projectLabel();
  console.log('');
  console.log('!!  About to reset both configured databases:');
  console.log(`    project: ${project}`);
  console.log(`    sheet:   ${spreadsheetLabel()}`);
  console.log('');
  console.log('This will delete every member, event, transaction, slideshow, task,');
  console.log('deposit slip, purchase order, login, notification, and audit entry');
  console.log('from MongoDB, then clear the corresponding Google Sheets rows.');
  console.log('The $3,320.97 starting balance will be re-seeded.');
  console.log('Stop the website server before continuing.');
  console.log('');

  const auto = process.argv.includes('--yes') || process.argv.includes('-y');
  if (!auto) {
    const expected = 'RESET';
    const prompt = `Type "${expected}" to wipe, or anything else to cancel: `;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(prompt, a => { rl.close(); resolve(a); }));
    if (answer.trim() !== expected) {
      console.log('Cancelled. No changes made.');
      process.exit(0);
    }
  } else {
    console.log('--yes supplied: skipping confirmation.');
  }

  try {
    console.log('Checking Google Sheets access and saving a final pre-reset snapshot...');
    const result = await resetDatabases();
    console.log('');
    console.log('Both databases were reset and verified.');
    console.log('  - 0 members, events, transactions, slideshows, tasks, etc.');
    console.log('  - Starting balance: $3,320.97');
    console.log(`  - Google Sheets state: ${result.status.state}`);
    process.exit(0);
  } catch (e) {
    console.error('Reset failed:', e.message || e);
    console.error('If the database was already cleared, rerun this command to finish syncing Google Sheets.');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  COLLECTIONS,
  STARTING_BALANCE,
  assertCleanSnapshot,
  assertSheetsMatchSnapshot,
  deleteCollection,
  requireSheetsSync,
  resetDatabases,
};
