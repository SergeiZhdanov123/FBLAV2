const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTableMatrix,
  createBackupResponseMiddleware,
  createGoogleSheetsBackup,
  parseSpreadsheetId,
} = require('../google-sheets-backup');

test('parseSpreadsheetId accepts either an id or a full Google Sheets URL', () => {
  assert.equal(parseSpreadsheetId('abc_123-xyz'), 'abc_123-xyz');
  assert.equal(
    parseSpreadsheetId('https://docs.google.com/spreadsheets/d/abc_123-xyz/edit#gid=0'),
    'abc_123-xyz'
  );
});

test('write responses wait for Sheets and report the backup result', async () => {
  let finishSync;
  const syncGate = new Promise(resolve => { finishSync = resolve; });
  let ended = false;
  const headers = {};
  const backup = {
    logger: { error() {} },
    requestSync: async reason => {
      assert.equal(reason, 'POST /api/events');
      await syncGate;
      return { state: 'ready' };
    },
  };
  const middleware = createBackupResponseMiddleware(backup);
  const req = { method: 'POST', path: '/events', originalUrl: '/api/events' };
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) { headers[name] = value; },
    end() { ended = true; },
  };

  middleware(req, res, () => res.end('ok'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, false);
  finishSync();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, true);
  assert.equal(headers['X-Google-Sheets-Backup'], 'synced');
});

test('buildTableMatrix keeps stable ids, raw strings, and nested data', () => {
  const matrix = buildTableMatrix([
    {
      _document_id: '7',
      id: 7,
      name: 'Jordan',
      notes: '=not a formula',
      nested: { complete: true },
    },
  ]);

  assert.deepEqual(matrix.columns.slice(0, 3), ['id', '_document_id', 'name']);
  const notesIndex = matrix.columns.indexOf('notes');
  const nestedIndex = matrix.columns.indexOf('nested');
  const recoveryIndex = matrix.columns.indexOf('_backup_json');
  assert.equal(matrix.values[1][notesIndex], '=not a formula');
  assert.equal(matrix.values[1][nestedIndex], '{"complete":true}');
  assert.deepEqual(JSON.parse(matrix.values[1][recoveryIndex]), {
    _document_id: '7', id: 7, name: 'Jordan', notes: '=not a formula', nested: { complete: true },
  });
  assert.equal(recoveryIndex, matrix.columns.length - 1);
  assert.equal(matrix.rowCount, 1);
  assert.throws(
    () => buildTableMatrix([{ _document_id: 'oversized', notes: 'x'.repeat(50001) }]),
    /50,000 character cell limit/
  );
});

test('a sync creates, clears, rewrites, and formats every managed worksheet', async () => {
  const sheets = [{
    properties: { sheetId: 1, title: 'Sheet1', index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } },
    bandedRanges: [],
  }];
  const calls = [];
  let valueUpdate = null;

  const fakeFetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });

    if (url.includes('/values:batchClear')) return Response.json({ clearedRanges: [] });
    if (url.includes('/values:batchUpdate')) {
      valueUpdate = body;
      return Response.json({ totalUpdatedRows: 1 });
    }
    if (url.includes(':batchUpdate')) {
      for (const request of (body && body.requests) || []) {
        if (request.addSheet) {
          sheets.push({
            properties: {
              sheetId: Math.max(...sheets.map(sheet => sheet.properties.sheetId)) + 1,
              title: request.addSheet.properties.title,
              index: sheets.length,
              gridProperties: request.addSheet.properties.gridProperties,
            },
            bandedRanges: [],
          });
        }
        if (request.updateSheetProperties && request.updateSheetProperties.properties.title) {
          const target = sheets.find(sheet => sheet.properties.sheetId === request.updateSheetProperties.properties.sheetId);
          if (target) Object.assign(target.properties, request.updateSheetProperties.properties);
        }
      }
      return Response.json({ replies: [] });
    }
    return Response.json({ properties: { title: 'Backup' }, sheets });
  };

  const backup = createGoogleSheetsBackup({
    env: {
      GOOGLE_SHEETS_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'test@example.com', private_key: 'unused' }),
      GOOGLE_SHEETS_BACKUP_ID: 'test-sheet-id',
    },
    fetchImpl: fakeFetch,
    logger: { info() {}, error() {} },
    snapshotProvider: async () => ({
      generated_at: '2026-07-17T00:00:00.000Z',
      schema_version: 1,
      tables: {
        events: [{ id: 1, _document_id: '1', name: 'Regionals' }],
        counters: [{ _document_id: 'events', seq: 1 }],
      },
    }),
  });
  backup.authHeaders = async () => ({ authorization: 'Bearer test' });

  const status = await backup.requestSync('unit test');
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.rowCounts, { events: 1, counters: 1 });
  assert.ok(calls.some(call => call.url.includes('/values:batchClear')));
  assert.ok(calls.filter(call => call.url.includes(':batchUpdate')).length >= 2);
  assert.ok(valueUpdate);
  assert.equal(valueUpdate.valueInputOption, 'RAW');
  assert.ok(sheets.some(sheet => sheet.properties.title === 'Backup Status'));
  assert.ok(!sheets.some(sheet => sheet.properties.title === 'Sheet1'));
  assert.deepEqual(
    valueUpdate.data.map(item => item.range).sort(),
    ["'Backup Status'!A1", "'Counters'!A1", "'Events'!A1"].sort()
  );
});
