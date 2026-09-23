#!/usr/bin/env node
// ============================================================
// FBLA Hub MCP server (stdio)
//
// Exposes the chapter app's operations as agent-callable tools so an operator
// can drop a list of tasks (or a Google Calendar link) and have them done.
//
// SAFETY: this talks to the SAME database the app uses (MONGODB_DB, default
// fbla_v2). Everything it writes to the calendar, announcements, and forms is
// PUBLIC on the chapter hub. There are NO destructive tools (no delete/reset),
// and the calendar sync defaults to a dry run so you can review before writing.
// V2 has no student accounts, so there are no member tools.
// ============================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const db = require('../db');
const { parseIcs, fetchIcs } = require('../ics-import');
const { createGoogleSheetsBackup } = require('../google-sheets-backup');

const OPERATOR = process.env.FBLA_MCP_OPERATOR || 'MCP agent';

// The MCP writes straight to the database, so it doesn't pass through the API's
// audit logging or the Sheets-backup middleware. Reproduce both here: every
// mutation records an audit entry (tagged as MCP) and triggers a best-effort
// Google Sheets sync so the disaster-recovery workbook stays current. Backup is
// fire-and-forget: a Sheets hiccup must never fail the underlying write.
const sheetsBackup = createGoogleSheetsBackup({ snapshotProvider: () => db.backupJson() });
async function afterWrite(action, details) {
  try { await db.logAudit(OPERATOR, `mcp_${action}`, details || ''); }
  catch (e) { console.error('[mcp] audit log failed:', e.message); }
  try { await sheetsBackup.requestSync(`MCP ${action}`); }
  catch (e) { console.error('[mcp] Sheets backup failed:', e.message); }
}
const DB_NAME = process.env.MONGODB_DB || 'fbla_v2';
const CLUSTER = (() => {
  try { return (String(process.env.MONGODB_URI || '').match(/@([^/?]+)/) || [])[1] || 'unknown'; }
  catch (e) { return 'unknown'; }
})();

const server = new McpServer({ name: 'fbla-hub', version: '1.0.0' });

// Return helpers: MCP tool results are text content.
const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const json = (obj) => text(JSON.stringify(obj, null, 2));
const fail = (msg) => ({ content: [{ type: 'text', text: 'Error: ' + msg }], isError: true });
const wrap = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e.message || String(e)); } };

// ---------- Read-only ----------
server.registerTool('status', {
  title: 'Status',
  description: 'Show which database this MCP is connected to and a summary count of records. Call this first.',
}, wrap(async () => {
  const [events, txs, anns, forms, resources] = await Promise.all([
    db.listEvents(), db.listTransactions(), db.listAnnouncements(), db.listGoogleForms(), db.listSlideshows(),
  ]);
  return json({
    database: DB_NAME, cluster: CLUSTER, operator: OPERATOR,
    warning: 'Treat this as the real chapter hub: calendar, announcements, and forms written here are public.',
    counts: { events: events.length, transactions: txs.length, announcements: anns.length, google_forms: forms.length, resources: resources.length },
  });
}));

server.registerTool('list_events', { title: 'List events', description: 'List chapter events with dates and costs.' },
  wrap(async () => json((await db.listEvents()).map(e => ({ id: e.id, name: e.name, date: e.date, time: e.time || null, location: e.location || null, cost_per_member: e.cost_per_member, first_payment_due: e.first_payment_due, countdown: !!e.countdown_enabled })))));

server.registerTool('get_balance', { title: 'Get treasury balance', description: 'Current chapter balance, income, and expenses.' },
  wrap(async () => json(await db.getBalance())));

server.registerTool('list_transactions', {
  title: 'List transactions', description: 'List recent treasury transactions.',
  inputSchema: { limit: z.number().optional().describe('Max rows (default 50)') },
}, wrap(async ({ limit }) => json((await db.listTransactions()).slice(0, limit || 50))));

server.registerTool('list_google_forms', { title: 'List Google Forms', description: 'List the Google Form links officers shared (open ones show on the public hub).' },
  wrap(async () => json((await db.listGoogleForms()).map(f => ({ id: f.id, title: f.title, url: f.url, open: !!f.open, due_date: f.due_date, event: f.event_name })))));

server.registerTool('list_calendar', { title: 'List calendar', description: 'List calendar items (chapter dates, events, deadlines).' },
  wrap(async () => json(await db.listCalendar())));

// ---------- Writes (live) ----------
server.registerTool('add_event', {
  title: 'Add event', description: 'Add a chapter event (conference, competition, trip). It shows on the public calendar with its payment due dates.',
  inputSchema: {
    name: z.string(), date: z.string().describe('YYYY-MM-DD'), time: z.string().optional().describe('HH:MM'),
    location: z.string().optional(), cost_per_member: z.number().optional(),
    first_payment_due: z.string().optional().describe('YYYY-MM-DD'), description: z.string().optional(),
    countdown: z.boolean().optional().describe('Show a countdown banner on the hub'),
  },
}, wrap(async (a) => {
  const e = await db.addEvent({ ...a, countdown_enabled: a.countdown ? 1 : 0 });
  await afterWrite('add_event', `${e.name} (id=${e.id})`);
  return json({ ok: true, id: e.id, name: e.name, date: e.date });
}));

server.registerTool('record_transaction', {
  title: 'Record transaction', description: 'Record a treasury income or expense.',
  inputSchema: {
    description: z.string(), amount: z.number(), type: z.enum(['income', 'expense']),
    date: z.string().optional(), category: z.string().optional(), payment_method: z.string().optional(),
  },
}, wrap(async (a) => {
  const t = await db.addTransaction({ ...a, recorded_by: OPERATOR });
  await afterWrite('record_transaction', `${t.type} $${t.amount} (id=${t.id})`);
  return json({ ok: true, id: t.id, type: t.type, amount: t.amount });
}));

server.registerTool('add_announcement', {
  title: 'Post announcement', description: 'Post a public announcement on the chapter hub.',
  inputSchema: {
    title: z.string(), body: z.string().optional(), pinned: z.boolean().optional(),
    category: z.enum(['Chapter news', 'Competition', 'Deadlines', 'Resources']).optional(),
  },
}, wrap(async (a) => {
  const ann = await db.addAnnouncement({ title: a.title, body: a.body, category: a.category, pinned: a.pinned ? 1 : 0 }, OPERATOR);
  await afterWrite('add_announcement', ann.title);
  return json({ ok: true, id: ann.id, title: ann.title });
}));

server.registerTool('add_google_form', {
  title: 'Add Google Form', description: 'Share a Google Form link on the public hub\'s Forms page.',
  inputSchema: { title: z.string(), url: z.string().describe('https://forms.gle/... or https://docs.google.com/forms/...'), description: z.string().optional(), due_date: z.string().optional().describe('YYYY-MM-DD respond-by date') },
}, wrap(async (a) => { const f = await db.addGoogleForm(a, OPERATOR); await afterWrite('add_google_form', f.title); return json({ ok: true, id: f.id, title: f.title }); }));

server.registerTool('add_calendar_item', {
  title: 'Add calendar item', description: 'Add a single date to the chapter calendar.',
  inputSchema: {
    title: z.string(), date: z.string().describe('YYYY-MM-DD'), time: z.string().optional(),
    kind: z.enum(['meeting', 'event', 'deadline', 'other']).optional(), location: z.string().optional(), description: z.string().optional(),
  },
}, wrap(async (a) => { const c = await db.addCalendarItem(a, OPERATOR); await afterWrite('add_calendar_item', `${c.title} on ${c.date}`); return json({ ok: true, id: c.id, title: c.title, date: c.date }); }));

server.registerTool('sync_google_calendar', {
  title: 'Sync a Google Calendar (iCal link)', description: 'Fetch a public iCal (.ics) URL and push its events onto the chapter calendar. Idempotent (re-syncing updates, does not duplicate). Defaults to a DRY RUN so you can review; set dryRun=false to apply.',
  inputSchema: { ical_url: z.string().describe("The calendar's public 'iCal format' URL (https:// or webcal://)"), dryRun: z.boolean().optional() },
}, wrap(async (a) => {
  const dry = a.dryRun !== false;
  const raw = await fetchIcs(a.ical_url);
  const events = parseIcs(raw);
  if (!events.length) return json({ parsed: 0, note: 'No events found in that calendar feed.' });
  const result = await db.importCalendarItems(events, { dryRun: dry, createdBy: 'Google Calendar sync' });
  if (!dry) await afterWrite('sync_google_calendar', `parsed=${events.length}`);
  return json({ dryRun: dry, parsed: events.length, ...result, sample: events.slice(0, 5) });
}));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`FBLA MCP server ready. DB=${DB_NAME} @ ${CLUSTER}.`);
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
