// Minimal iCalendar (.ics) reader for the "drop a Google Calendar link" sync.
// Google Calendars expose a "Public address in iCal format" URL; this fetches
// and parses its VEVENTs into { uid, title, date, end_date, time, location, description }.
//
// Times: Google publishes timed events in UTC (a trailing Z). Those are
// converted to the calendar's own time zone (X-WR-TIMEZONE, else
// America/New_York), so an 8:00 AM meeting shows as 8:00, not 12:00. Times
// given with a TZID are already local and are read as-is. All-day events
// (VALUE=DATE) have time = null.

function unfold(text) {
  // RFC 5545 line folding: a CRLF followed by a space/tab continues the line.
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return String(v || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

const DEFAULT_TZ = 'America/New_York';

// A UTC moment -> { date, time } on the wall clock of `tz`.
function utcToZone(y, mo, d, h, mi, tz) {
  const moment = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  let zone = tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch (e) { zone = DEFAULT_TZ; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(moment).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// "20260830" -> {date:"2026-08-30", time:null}; "20260830T180000" -> time "18:00";
// "20261001T120000Z" (UTC) -> converted to `tz`, e.g. 2026-10-01 08:00 in New York.
function parseDt(v, tz = DEFAULT_TZ) {
  if (!v) return { date: null, time: null };
  const m = String(v).match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z?))?/);
  if (!m) return { date: null, time: null };
  if (m[4] && m[6] === 'Z') return utcToZone(m[1], m[2], m[3], m[4], m[5], tz);
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : null };
}

// Shift a "YYYY-MM-DD" date by n days (UTC math, no timezone drift).
function addDays(ds, n) {
  const d = new Date(ds + 'T00:00:00Z');
  if (isNaN(d)) return ds;
  return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
}

function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const tzLine = lines.find(l => /^X-WR-TIMEZONE:/i.test(l));
  const tz = tzLine ? tzLine.slice(tzLine.indexOf(':') + 1).trim() : DEFAULT_TZ;
  const events = [];
  let cur = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (trimmed === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (key === 'UID') cur.uid = value.trim();
    else if (key === 'SUMMARY') cur.title = unescapeText(value);
    else if (key === 'DESCRIPTION') cur.description = unescapeText(value);
    else if (key === 'LOCATION') cur.location = unescapeText(value);
    else if (key === 'DTSTART') cur.dtstart = value.trim();
    else if (key === 'DTEND') { cur.dtend = value.trim(); cur.dtendIsDate = /VALUE=DATE/i.test(line.slice(0, idx)); }
  }
  return events
    .map(e => {
      const { date, time } = parseDt(e.dtstart, tz);
      // Multi-day events: DTEND for all-day events is EXCLUSIVE (an event on
      // just Oct 10 has DTEND Oct 11), so subtract a day; timed DTEND is the
      // actual end moment, so its date is used as-is. Only spans longer than a
      // single day get an end_date.
      let end_date = null;
      if (e.dtend && date) {
        const end = parseDt(e.dtend, tz);
        if (end.date) {
          const isAllDay = e.dtendIsDate || !end.time;
          const effective = isAllDay ? addDays(end.date, -1) : end.date;
          if (effective > date) end_date = effective;
        }
      }
      return { uid: e.uid || null, title: e.title || '(untitled)', description: e.description || null, location: e.location || null, date, end_date, time };
    })
    .filter(e => e.date)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

async function fetchIcs(url) {
  const httpUrl = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(httpUrl)) throw new Error('Provide an http(s) or webcal iCal URL.');
  const res = await fetch(httpUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not fetch the calendar (HTTP ${res.status}). Make sure the iCal URL is public.`);
  return res.text();
}

module.exports = { parseIcs, fetchIcs, parseDt, unescapeText };
