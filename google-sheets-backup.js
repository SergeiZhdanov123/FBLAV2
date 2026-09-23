const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCHEMA_VERSION = 1;

const TABLE_TITLES = Object.freeze({
  events: 'Events',
  transactions: 'Transactions',
  settings: 'Settings',
  audit_log: 'Audit Log',
  deposit_slips: 'Deposit Slips',
  purchase_orders: 'Purchase Orders',
  slideshows: 'Resources',
  announcements: 'Announcements',
  calendar_items: 'Calendar Items',
  officer_calendar_items: 'Officer Calendar',
  google_forms: 'Google Forms',
  officers: 'Officers',
  counters: 'Counters',
});

const PREFERRED_COLUMNS = [
  'id', '_document_id', 'key', 'name', 'title', 'date', 'created_at', 'updated_at',
  'event_id', 'status', 'type', 'category', 'amount',
];

function normalizePrivateKey(credentials) {
  if (credentials && credentials.private_key && credentials.private_key.includes('\\n')) {
    return { ...credentials, private_key: credentials.private_key.replace(/\\n/g, '\n') };
  }
  return credentials;
}

function loadCredentials(env = process.env) {
  if (env.GOOGLE_SHEETS_SERVICE_ACCOUNT) {
    try {
      return normalizePrivateKey(JSON.parse(env.GOOGLE_SHEETS_SERVICE_ACCOUNT));
    } catch (error) {
      throw new Error(`GOOGLE_SHEETS_SERVICE_ACCOUNT is not valid JSON: ${error.message}`);
    }
  }

  const configuredPath = String(env.GOOGLE_SHEETS_CREDENTIALS || '').trim();
  if (!configuredPath) return null;
  const credentialsPath = path.resolve(configuredPath);
  let raw;
  try {
    raw = fs.readFileSync(credentialsPath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read GOOGLE_SHEETS_CREDENTIALS: ${error.message}`);
  }
  try {
    return normalizePrivateKey(JSON.parse(raw));
  } catch (error) {
    throw new Error(`GOOGLE_SHEETS_CREDENTIALS is not valid JSON: ${error.message}`);
  }
}

function timestampValue(value) {
  if (!value || typeof value !== 'object' || typeof value.toDate !== 'function') return null;
  try { return value.toDate().toISOString(); } catch (error) { return null; }
}

function normalizeJsonValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const timestamp = timestampValue(value);
  if (timestamp) return timestamp;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeJsonValue(nested)]));
  }
  return value;
}

function enforceCellLimit(value, label = 'A backup value') {
  if (typeof value === 'string' && value.length > 50000) {
    throw new Error(`${label} exceeds the Google Sheets 50,000 character cell limit`);
  }
  return value;
}

function cellValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return enforceCellLimit(value.toISOString());
  const timestamp = timestampValue(value);
  if (timestamp) return enforceCellLimit(timestamp);
  if (typeof value === 'string') return enforceCellLimit(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  const serialized = JSON.stringify(normalizeJsonValue(value));
  return enforceCellLimit(serialized);
}

function orderedColumns(rows) {
  const found = new Set();
  for (const row of rows) Object.keys(row || {}).forEach(key => found.add(key));
  if (!found.size) found.add('_document_id');
  const preferred = PREFERRED_COLUMNS.filter(key => found.delete(key));
  return [...preferred, ...Array.from(found).sort((a, b) => a.localeCompare(b))];
}

function buildTableMatrix(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const columns = [...orderedColumns(safeRows).filter(column => column !== '_backup_json'), '_backup_json'];
  return {
    columns,
    values: [columns, ...safeRows.map(row => columns.map(column => {
      if (column !== '_backup_json') return cellValue(row[column]);
      const serialized = JSON.stringify(normalizeJsonValue(row));
      return enforceCellLimit(serialized, 'A recovery JSON row');
    }))],
    rowCount: safeRows.length,
  };
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function rgb(hex) {
  const clean = hex.replace('#', '');
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

function safeErrorMessage(error) {
  return String(error && error.message ? error.message : error || 'Unknown error').slice(0, 800);
}

function parseSpreadsheetId(value) {
  const raw = String(value || '').trim();
  const fromUrl = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return fromUrl ? fromUrl[1] : raw;
}

class GoogleSheetsBackup {
  constructor({ snapshotProvider, env = process.env, fetchImpl = global.fetch, logger = console } = {}) {
    if (typeof snapshotProvider !== 'function') throw new Error('snapshotProvider is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    this.snapshotProvider = snapshotProvider;
    this.env = env;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.activeSync = null;
    this.authClient = null;
    this.authClientEmail = null;
    this.syncRequested = false;
    this.pendingReasons = new Set();
    this.status = {
      state: 'not_configured',
      configured: false,
      spreadsheetUrl: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      durationMs: null,
      rowCounts: {},
      schemaVersion: SCHEMA_VERSION,
    };
    this.refreshConfigurationStatus();
  }

  refreshConfigurationStatus() {
    const spreadsheetId = parseSpreadsheetId(this.env.GOOGLE_SHEETS_BACKUP_ID);
    let credentials = null;
    let error = null;
    try { credentials = loadCredentials(this.env); } catch (caught) { error = caught; }
    const configured = !!spreadsheetId && !!credentials && !error;
    this.status.configured = configured;
    this.status.spreadsheetUrl = spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null;
    if (configured && this.status.state === 'not_configured') {
      this.status.state = 'pending';
      this.status.lastError = null;
    }
    if (!configured && this.status.state !== 'syncing') {
      this.status.state = 'not_configured';
      this.status.lastError = error
        ? safeErrorMessage(error)
        : (!credentials
          ? 'Google Sheets credentials are not configured.'
          : 'GOOGLE_SHEETS_BACKUP_ID is not configured.');
    }
    return { spreadsheetId, credentials, error, configured };
  }

  getStatus() {
    this.refreshConfigurationStatus();
    return JSON.parse(JSON.stringify(this.status));
  }

  async requestSync(reason = 'database write') {
    this.pendingReasons.add(String(reason || 'database write'));
    this.syncRequested = true;
    if (this.activeSync) return this.activeSync;

    this.activeSync = (async () => {
      let result = this.getStatus();
      while (this.syncRequested) {
        this.syncRequested = false;
        const reasons = Array.from(this.pendingReasons);
        this.pendingReasons.clear();
        result = await this.performSync(reasons.join(', '));
      }
      return result;
    })().finally(() => { this.activeSync = null; });

    return this.activeSync;
  }

  async performSync(reason) {
    const config = this.refreshConfigurationStatus();
    if (!config.configured) return this.getStatus();

    const started = Date.now();
    this.status.state = 'syncing';
    this.status.lastAttemptAt = new Date().toISOString();
    this.status.lastError = null;

    try {
      const snapshot = await this.snapshotProvider();
      const generatedAt = new Date().toISOString();
      const tableEntries = Object.entries(snapshot.tables || {});
      const tableMatrices = {};
      const rowCounts = {};

      for (const [collection, rows] of tableEntries) {
        const title = TABLE_TITLES[collection] || collection.replace(/_/g, ' ');
        tableMatrices[title] = buildTableMatrix(rows);
        rowCounts[collection] = Array.isArray(rows) ? rows.length : 0;
      }

      const statusMatrix = this.buildStatusMatrix({
        generatedAt,
        reason,
        rowCounts,
        tableEntries,
      });
      const matrices = { 'Backup Status': statusMatrix, ...tableMatrices };

      await this.writeWorkbook(config, matrices);
      this.status.state = 'ready';
      this.status.lastSuccessAt = generatedAt;
      this.status.durationMs = Date.now() - started;
      this.status.rowCounts = rowCounts;
      this.status.lastError = null;
      this.logger.info(`Google Sheets backup synced ${Object.values(rowCounts).reduce((sum, count) => sum + count, 0)} rows.`);
    } catch (error) {
      this.status.state = 'error';
      this.status.durationMs = Date.now() - started;
      this.status.lastError = safeErrorMessage(error);
      this.logger.error('Google Sheets backup failed:', this.status.lastError);
    }

    return this.getStatus();
  }

  buildStatusMatrix({ generatedAt, reason, rowCounts, tableEntries }) {
    const rows = [
      ['Google Sheets Disaster Recovery Backup', '', '', ''],
      ['Snapshot generated', generatedAt, '', ''],
      ['Trigger', reason || 'database write', '', ''],
      ['Schema version', SCHEMA_VERSION, '', ''],
      ['Source', 'MongoDB', '', ''],
      ['Instructions', 'The app is the primary database. Use this workbook for recovery if the database is unavailable. Each data sheet has a hidden exact-recovery JSON column.', '', ''],
      ['', '', '', ''],
      ['Collection', 'Worksheet', 'Rows', 'Document ID included'],
    ];
    for (const [collection] of tableEntries) {
      rows.push([collection, TABLE_TITLES[collection] || collection.replace(/_/g, ' '), rowCounts[collection] || 0, 'Yes']);
    }
    return { columns: rows[7], values: rows, rowCount: rows.length - 1, isStatus: true };
  }

  async authHeaders(credentials) {
    if (!this.authClient || this.authClientEmail !== credentials.client_email) {
      const auth = new GoogleAuth({ credentials, scopes: [SHEETS_SCOPE] });
      this.authClient = await auth.getClient();
      this.authClientEmail = credentials.client_email || null;
    }
    const requestHeaders = await this.authClient.getRequestHeaders();
    if (requestHeaders && typeof requestHeaders.entries === 'function') {
      return Object.fromEntries(requestHeaders.entries());
    }
    return { ...requestHeaders };
  }

  async apiRequest(config, suffix = '', options = {}) {
    const authHeaders = await this.authHeaders(config.credentials);
    const timeoutMs = Math.max(1000, Number(this.env.GOOGLE_SHEETS_REQUEST_TIMEOUT_MS) || 8000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetch(`${API_ROOT}/${encodeURIComponent(config.spreadsheetId)}${suffix}`, {
        ...options,
        signal: controller.signal,
        headers: {
          ...authHeaders,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error(`Google Sheets API request timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (error) { body = text; }
    if (!response.ok) {
      const message = body && body.error && body.error.message ? body.error.message : (text || response.statusText);
      throw new Error(`Google Sheets API returned ${response.status}: ${message}`);
    }
    return body;
  }

  async spreadsheetMetadata(config) {
    const fields = 'properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),bandedRanges(bandedRangeId))';
    return this.apiRequest(config, `?fields=${encodeURIComponent(fields)}`);
  }

  async writeWorkbook(config, matrices) {
    let metadata = await this.spreadsheetMetadata(config);
    const existing = new Map((metadata.sheets || []).map(sheet => [sheet.properties.title, sheet]));
    const structuralRequests = [];

    // A newly created spreadsheet starts with one blank "Sheet1" tab. Reuse
    // it for backup status instead of leaving a confusing empty worksheet.
    if ((metadata.sheets || []).length === 1 && existing.has('Sheet1') && !existing.has('Backup Status')) {
      const defaultSheet = existing.get('Sheet1');
      structuralRequests.push({
        updateSheetProperties: {
          properties: { sheetId: defaultSheet.properties.sheetId, title: 'Backup Status', index: 0 },
          fields: 'title,index',
        },
      });
      existing.delete('Sheet1');
      existing.set('Backup Status', {
        ...defaultSheet,
        properties: { ...defaultSheet.properties, title: 'Backup Status', index: 0 },
      });
    }

    for (const [title, matrix] of Object.entries(matrices)) {
      const requiredRows = Math.max(100, matrix.values.length + 25);
      const requiredColumns = Math.max(10, matrix.columns.length + 2);
      const sheet = existing.get(title);
      if (!sheet) {
        structuralRequests.push({
          addSheet: { properties: {
            title,
            ...(title === 'Backup Status' ? { index: 0 } : {}),
            gridProperties: { rowCount: requiredRows, columnCount: requiredColumns },
          } },
        });
        continue;
      }
      const grid = sheet.properties.gridProperties || {};
      if ((grid.rowCount || 0) < requiredRows || (grid.columnCount || 0) < requiredColumns) {
        structuralRequests.push({
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: {
                rowCount: Math.max(grid.rowCount || 0, requiredRows),
                columnCount: Math.max(grid.columnCount || 0, requiredColumns),
              },
            },
            fields: 'gridProperties(rowCount,columnCount)',
          },
        });
      }
    }

    if (structuralRequests.length) {
      await this.apiRequest(config, ':batchUpdate', {
        method: 'POST', body: JSON.stringify({ requests: structuralRequests }),
      });
      metadata = await this.spreadsheetMetadata(config);
    }

    const managedTitles = Object.keys(matrices);
    await this.apiRequest(config, '/values:batchClear', {
      method: 'POST',
      body: JSON.stringify({ ranges: managedTitles.map(title => quoteSheetTitle(title)) }),
    });

    await this.apiRequest(config, '/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: managedTitles.map(title => ({
          range: `${quoteSheetTitle(title)}!A1`,
          majorDimension: 'ROWS',
          values: matrices[title].values,
        })),
      }),
    });

    await this.formatWorkbook(config, metadata, matrices);
  }

  async formatWorkbook(config, metadata, matrices) {
    const sheetMap = new Map((metadata.sheets || []).map(sheet => [sheet.properties.title, sheet]));
    const requests = [];
    const navy = rgb('#0b2b5f');
    const white = rgb('#ffffff');
    const paleBlue = rgb('#eef4ff');

    for (const [title, matrix] of Object.entries(matrices)) {
      const sheet = sheetMap.get(title);
      if (!sheet) continue;
      const sheetId = sheet.properties.sheetId;
      const rowEnd = Math.max(1, matrix.values.length);
      const columnEnd = Math.max(1, matrix.columns.length);

      for (const banding of sheet.bandedRanges || []) {
        requests.push({ deleteBanding: { bandedRangeId: banding.bandedRangeId } });
      }
      requests.push({ clearBasicFilter: { sheetId } });
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: matrix.isStatus ? 8 : 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      });
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: rowEnd, startColumnIndex: 0, endColumnIndex: columnEnd },
          cell: { userEnteredFormat: { verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' } },
          fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)',
        },
      });
      requests.push({
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columnEnd },
        },
      });

      if (matrix.isStatus) {
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnEnd },
            cell: { userEnteredFormat: { backgroundColor: navy, textFormat: { foregroundColor: white, bold: true, fontSize: 14 } } },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: columnEnd },
            cell: { userEnteredFormat: { backgroundColor: navy, textFormat: { foregroundColor: white, bold: true } } },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
        continue;
      }

      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: columnEnd - 1, endIndex: columnEnd },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      });

      requests.push({
        addBanding: {
          bandedRange: {
            range: { sheetId, startRowIndex: 0, endRowIndex: rowEnd, startColumnIndex: 0, endColumnIndex: columnEnd },
            rowProperties: { headerColor: navy, firstBandColor: white, secondBandColor: paleBlue },
          },
        },
      });
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnEnd },
          cell: { userEnteredFormat: { textFormat: { foregroundColor: white, bold: true } } },
          fields: 'userEnteredFormat.textFormat',
        },
      });
      if (rowEnd > 1) {
        requests.push({
          setBasicFilter: {
            filter: { range: { sheetId, startRowIndex: 0, endRowIndex: rowEnd, startColumnIndex: 0, endColumnIndex: columnEnd } },
          },
        });
      }
    }

    if (requests.length) {
      await this.apiRequest(config, ':batchUpdate', {
        method: 'POST', body: JSON.stringify({ requests }),
      });
    }
  }
}

function createGoogleSheetsBackup(options) {
  return new GoogleSheetsBackup(options);
}

function createBackupResponseMiddleware(backup, options = {}) {
  if (!backup || typeof backup.requestSync !== 'function') throw new Error('backup.requestSync is required');
  // blocking (default true): hold the response until the workbook sync
  // finishes. Required on serverless hosts (Vercel), where the instance can be
  // frozen the moment the response is sent, so a background sync would never
  // complete. On an always-on server (Render), pass blocking: false so the
  // response returns immediately and the sync runs in the background; failures
  // are logged and still visible in the admin backup status panel.
  const blocking = options.blocking !== false;
  return (req, res, next) => {
    const changesDatabase = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      || (req.method === 'GET' && req.path === '/backup');
    const isBackupControl = req.path.startsWith('/google-sheets-backup');
    if (!changesDatabase || isBackupControl) return next();

    const originalEnd = res.end.bind(res);
    let ending = false;
    res.end = function delayedEnd(chunk, encoding, callback) {
      if (ending) return res;
      ending = true;
      // Only a successful (2xx) mutation actually changed the database. Failed
      // requests (400/401/403 validation or auth errors, 404s) and server errors
      // (5xx) leave data untouched, so rewriting the entire Google workbook for
      // them is wasted latency, API load, and an abuse vector. Skip them.
      const mutated = res.statusCode >= 200 && res.statusCode < 300;
      if (!mutated) return originalEnd(chunk, encoding, callback);

      const reason = `${req.method} ${req.originalUrl.split('?')[0]}`;
      if (!blocking) {
        // Respond now; sync in the background. requestSync already coalesces
        // overlapping requests into one run, so a burst of writes does not
        // stack up redundant workbook rewrites.
        backup.requestSync(reason).then(status => {
          if (status.state === 'error' && backup.logger && backup.logger.error) {
            backup.logger.error('Google Sheets backup failed:', status.lastError);
          }
        }).catch(error => {
          if (backup.logger && backup.logger.error) backup.logger.error('Google Sheets backup failed:', error);
        });
        return originalEnd(chunk, encoding, callback);
      }
      backup.requestSync(reason).then(status => {
        if (!res.headersSent) {
          const header = status.state === 'ready'
            ? 'synced'
            : (status.state === 'not_configured' ? 'not-configured' : 'failed');
          res.setHeader('X-Google-Sheets-Backup', header);
        }
        originalEnd(chunk, encoding, callback);
      }).catch(error => {
        if (backup.logger && backup.logger.error) backup.logger.error('Google Sheets backup response hook failed:', error);
        if (!res.headersSent) res.setHeader('X-Google-Sheets-Backup', 'failed');
        originalEnd(chunk, encoding, callback);
      });
      return res;
    };
    next();
  };
}

module.exports = {
  SCHEMA_VERSION,
  TABLE_TITLES,
  buildTableMatrix,
  cellValue,
  createBackupResponseMiddleware,
  createGoogleSheetsBackup,
  loadCredentials,
  parseSpreadsheetId,
};
