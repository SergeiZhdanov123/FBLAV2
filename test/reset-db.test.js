const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COLLECTIONS,
  STARTING_BALANCE,
  assertCleanSnapshot,
  assertSheetsMatchSnapshot,
  resetDatabases,
} = require('../reset-db');

function cleanSnapshot() {
  const tables = Object.fromEntries(COLLECTIONS.map(collection => [collection, []]));
  tables.settings = [{
    _document_id: 'starting_balance',
    key: 'starting_balance',
    value: STARTING_BALANCE,
  }];
  return { schema_version: 1, tables };
}

test('clean reset validation requires empty collections and the starting balance', () => {
  const snapshot = cleanSnapshot();
  assert.equal(assertCleanSnapshot(snapshot), true);

  snapshot.tables.events.push({ _document_id: '1', id: 1 });
  assert.throws(() => assertCleanSnapshot(snapshot), /events: expected 0, found 1/);
});

test('Sheets reset validation compares every collection count', () => {
  const snapshot = cleanSnapshot();
  const rowCounts = Object.fromEntries(COLLECTIONS.map(collection => [collection, snapshot.tables[collection].length]));
  assert.equal(assertSheetsMatchSnapshot({ state: 'ready', rowCounts }, snapshot), true);

  rowCounts.events = 2;
  assert.throws(
    () => assertSheetsMatchSnapshot({ state: 'ready', rowCounts }, snapshot),
    /events: expected 0, synced 2/
  );
});

test('database reset preflights Sheets, clears Firebase, and syncs the clean snapshot', async () => {
  const stored = new Map(COLLECTIONS.map(collection => [collection, [{ id: `${collection}-row` }]]));
  const firestore = {
    collection(name) {
      return {
        limit() {
          return {
            async get() {
              const rows = stored.get(name) || [];
              return {
                empty: rows.length === 0,
                size: rows.length,
                docs: rows.map((row, index) => ({ ref: { name, index, row } })),
              };
            },
          };
        },
        doc(id) {
          return {
            async set(value) { stored.set(name, [{ ...value, _document_id: id }]); },
          };
        },
      };
    },
    batch() {
      const removals = [];
      return {
        delete(ref) { removals.push(ref); },
        async commit() {
          for (const ref of removals) stored.set(ref.name, []);
        },
      };
    },
  };
  const database = {
    ensureFirebase: () => firestore,
    async backupJson() {
      const tables = {};
      for (const collection of COLLECTIONS) {
        tables[collection] = (stored.get(collection) || []).map((row, index) => ({
          ...row,
          _document_id: row._document_id || String(index),
        }));
      }
      return { schema_version: 1, tables };
    },
  };
  const reasons = [];
  const sheetsBackup = {
    async requestSync(reason) {
      reasons.push(reason);
      const snapshot = await database.backupJson();
      return {
        state: 'ready',
        rowCounts: Object.fromEntries(COLLECTIONS.map(collection => [collection, snapshot.tables[collection].length])),
      };
    },
  };

  const result = await resetDatabases({ database, sheetsBackup });
  assert.deepEqual(reasons, ['pre-reset access check', 'database reset']);
  assert.equal(result.snapshot.tables.events.length, 0);
  assert.equal(result.snapshot.tables.settings[0].value, STARTING_BALANCE);
  assertCleanSnapshot(result.snapshot);
});
