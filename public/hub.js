// ============================================================
// Public chapter hub (index.html)
// ============================================================
// Everything here is public chapter information read from /api/public/hub:
// the calendar, events and their countdowns, announcements, Google Form links,
// and meeting/study resources. There are no student accounts and nothing to
// sign in to. The only sign-in is the "Officer sign in" button, which leads to
// the officer console at /officer.
//
// Browser storage holds per-device conveniences only (the picked Study & Prep
// event, which updates this device has already seen). Every read and write is
// wrapped, so the hub works the same with storage blocked.
'use strict';

const icons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  trophy: '<path d="M8 3h8v8a4 4 0 0 1-8 0ZM8 5H4v4a4 4 0 0 0 4 4m8-8h4v4a4 4 0 0 1-4 4m-4 2v6m-4 0h8"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  external: '<path d="M14 3h7v7m0-7L10 14m0-10H4a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-6"/>',
  pin: '<path d="m9 3 6 0-1 5 4 4v2H6v-2l4-4ZM12 14v7"/>',
  location: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  slides: '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M12 17v4m-4 0h8m-9-9 3-3 3 2 4-4"/>',
  file: '<path d="M14 3H5v18h14V8ZM14 3v5h5M8 12h8m-8 4h5"/>',
  book: '<path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17v.1"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (selector) => document.querySelector(selector);
// Only http(s) links are ever rendered as hrefs (the server already refuses
// anything else; this guards the browser side too).
const safeUrl = (u) => /^https?:\/\//i.test(String(u || '').trim()) ? esc(String(u).trim()) : '';

const store = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage blocked: fine */ } },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NAV = [
  ['home', 'home', 'Home'],
  ['calendar', 'calendar', 'Calendar'],
  ['forms', 'file', 'Forms'],
  ['updates', 'bell', 'Announcements'],
  ['resources', 'slides', 'Meeting Resources'],
  ['prep', 'book', 'Study & Prep'],
  ['general', 'folder', 'General Resources'],
];
// The three kinds of resource officers post, and where each one lives.
const RESOURCE_KINDS = {
  slideshow: { page: 'resources', title: 'Meeting Resources', one: 'Meeting resource', icon: 'slides' },
  resource: { page: 'prep', title: 'Study & Prep', one: 'Study material', icon: 'book' },
  general: { page: 'general', title: 'General Resources', one: 'General resource', icon: 'folder' },
};
const kindInfo = (kind) => RESOURCE_KINDS[kind] || RESOURCE_KINDS.slideshow;
const PAGE_TITLES = Object.fromEntries(NAV.map(([id, , title]) => [id, title]));

const now = new Date();
const state = {
  data: null,
  page: 'home',
  month: now.getMonth(),
  year: now.getFullYear(),
  calendarView: window.innerWidth <= 550 ? 'list' : 'month',
  updateFilter: 'All',
  resourceQuery: '',
  prepQuery: '',
  generalQuery: '',
};

// ---------- dates ----------
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const parts = (ds) => { const [y, m, d] = String(ds).split('-').map(Number); return { y, m, d }; };
const dateLabel = (ds) => { if (!ds) return ''; const { y, m, d } = parts(ds); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const shortDate = (ds) => { if (!ds) return ''; const { m, d } = parts(ds); return `${MONTHS[m - 1].slice(0, 3)} ${d}`; };
// "14:30" -> "2:30 PM".
function fmtTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return hhmm || '';
  let h = Number(m[1]);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}
// Server timestamps are "YYYY-MM-DD HH:MM:SS" in UTC.
function stampDate(ts) {
  const d = new Date(String(ts || '').replace(' ', 'T') + (String(ts || '').length === 19 ? 'Z' : ''));
  return Number.isNaN(d.getTime()) ? null : d;
}
function postedLabel(ts) {
  const d = stampDate(ts);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
}

// ---------- data helpers ----------
const D = () => state.data || { config: {}, announcements: [], calendar: [], events: [], resources: [], forms: [], countdowns: [], leadership: [] };
const cfg = () => D().config || {};
const chapterName = () => (cfg().chapter_name || '').trim() || 'State High FBLA';

function customTypes() {
  try {
    const arr = JSON.parse(cfg().calendar_event_types || '[]');
    return Array.isArray(arr) ? arr.filter(t => t && t.key && t.label) : [];
  } catch (e) { return []; }
}
const BUILTIN_KINDS = { meeting: 'Meeting', event: 'Event', deadline: 'Deadline', other: 'Other' };
function kindMeta(kind) {
  if (BUILTIN_KINDS[kind]) return { cls: kind, label: BUILTIN_KINDS[kind], color: null };
  const t = customTypes().find(x => x.key === kind);
  return t ? { cls: 'custom', label: t.label, color: t.color || '#1462d9' } : { cls: 'other', label: 'Other', color: null };
}
const kindStyle = (meta) => (meta.color ? ` style="background:${esc(meta.color)};color:#fff"` : '');

// Calendar entries get a stable client key: an event and its payment deadlines
// share an id, so the source and position disambiguate them.
function calendarItems() {
  const list = D().calendar || [];
  list.forEach((c, i) => { if (!c.key) c.key = `c${i}`; });
  return list;
}
const findItem = (key) => calendarItems().find(c => c.key === key);
const eventById = (id) => (D().events || []).find(e => e.id === Number(id));
const upcoming = () => {
  const t = todayISO();
  return calendarItems().filter(c => c.date && (c.date >= t || (c.end_date && c.end_date >= t)));
};
// Each item on every day it covers (multi-day items continue across days).
function itemsOn(ds) {
  return calendarItems().filter(c => c.date === ds || (c.end_date && c.date < ds && c.end_date >= ds));
}

// ---------- rendering helpers ----------
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); el.removeAttribute('data-icon'); });
}
function heading(title, description, action = '') {
  return `<section class="m-page-heading"><div><h1>${title}</h1><p class="m-subhead">${description}</p></div>${action}</section>`;
}
function sectionHeading(title, link, label, description = '') {
  return `<div class="m-section-head"><div><h2>${title}</h2>${description ? `<p class="m-subhead">${description}</p>` : ''}</div><a class="m-more-link" href="#${link}">${label} →</a></div>`;
}
function whenText(c) {
  const bits = [];
  if (c.time) bits.push(fmtTime(c.time));
  if (c.location) bits.push(c.location);
  if (!bits.length) bits.push(c.end_date ? `Through ${shortDate(c.end_date)}` : (c.kind === 'deadline' ? 'All day' : kindMeta(c.kind).label));
  return bits.join(', ');
}
function eventRow(c) {
  const { m, d } = parts(c.date);
  const meta = kindMeta(c.kind);
  return `<button class="m-event-row" data-action="item" data-id="${esc(c.key)}" type="button">
    <span class="m-event-date"><b>${d}</b><span>${MONTHS[m - 1].slice(0, 3).toUpperCase()}</span></span>
    <span class="m-event-info"><strong>${esc(c.title)}</strong><span>${esc(whenText(c))}</span></span>
    <span class="m-event-type ${meta.cls}"${kindStyle(meta)}>${esc(meta.label.toUpperCase())}</span>
  </button>`;
}
function updateRow(a) {
  return `<button class="m-ann-preview" data-action="update" data-id="${a.id}" type="button">
    <span class="m-ann-preview-top">${a.pinned ? `<span class="m-pin-mark">${icon('pin')} Pinned</span>` : ''}${isNewUpdate(a) ? '<span class="hub-new">NEW</span>' : ''}<time>${esc(postedLabel(a.created_at))}</time></span>
    <strong>${esc(a.title)}</strong>
    ${a.body ? `<p>${esc(String(a.body).length > 140 ? String(a.body).slice(0, 140).trim() + '…' : a.body)}</p>` : ''}
  </button>`;
}
function resourceRow(r) {
  const href = safeUrl(r.url);
  const inner = `<span class="m-resource-icon">${icon(kindInfo(r.kind).icon)}</span>
    <span class="m-resource-copy"><strong>${esc(r.title)}</strong><span>${esc(kindInfo(r.kind).title)}${r.event_name ? ', ' + esc(r.event_name) : r.competitive_event ? ', ' + esc(r.competitive_event) : ''}</span></span>${href ? icon('external') : ''}`;
  return href
    ? `<a class="m-resource-row" href="${href}" target="_blank" rel="noopener">${inner}<span class="sr-only"> (opens in a new tab)</span></a>`
    : `<a class="m-resource-row" href="#${kindInfo(r.kind).page}">${inner}</a>`;
}
// Red asterisk for a required form (with words for screen readers).
const reqMark = (f) => (f.required ? '<span class="req-mark" aria-hidden="true">*</span><span class="sr-only"> (required)</span>' : '');
function formRow(f) {
  const href = safeUrl(f.url);
  return `<a class="m-resource-row" href="${href || '#forms'}" ${href ? 'target="_blank" rel="noopener"' : ''}>
    <span class="m-resource-icon">${icon('file')}</span>
    <span class="m-resource-copy"><strong>${esc(f.title)}${reqMark(f)}</strong><span>${f.due_date ? `Respond by ${esc(shortDate(f.due_date))}` : (f.event_name ? esc(f.event_name) : 'Google Form')}</span></span>${href ? icon('external') : ''}
  </a>`;
}
// Where a resource link opens, in words a visitor recognizes.
function linkSource(url) {
  let u;
  try { u = new URL(url); } catch (e) { return ''; }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'docs.google.com') {
    if (u.pathname.startsWith('/presentation')) return 'Google Slides';
    if (u.pathname.startsWith('/document')) return 'Google Docs';
    if (u.pathname.startsWith('/spreadsheets')) return 'Google Sheets';
    if (u.pathname.startsWith('/forms')) return 'Google Forms';
  }
  if (host === 'drive.google.com') return 'Google Drive';
  if (/(^|\.)canva\.(com|link)$/.test(host)) return 'Canva';
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'YouTube';
  if (/(^|\.)quizlet\.com$/.test(host)) return 'Quizlet';
  if (/(^|\.)fbla\.org$/.test(host)) return 'fbla.org';
  return host;
}
// The picture at the top of a resource card: the officer's uploaded cover, or
// a plain drawn one on a pale background (a slide for meeting materials, a
// page for study materials, a form for Google Forms).
function resourceCover(r, tag) {
  if (r.has_cover) {
    return `<div class="res-cover res-cover-img"><img src="/api/public/resources/${r.id}/cover?v=${encodeURIComponent(r.cover_v || '')}" alt="" loading="lazy" decoding="async" /></div>`;
  }
  // Meeting resource: a slide deck (a slide with bullets, another behind it).
  if (r.kind === 'slideshow') {
    return `<div class="res-cover res-art" aria-hidden="true">
      <div class="art-deck">
        <div class="art-slide art-slide-back"></div>
        <div class="art-slide">
          <span class="art-slide-title">${esc(r.title)}</span>
          <span class="art-bullet"><i></i><b style="width:78%"></b></span>
          <span class="art-bullet"><i></i><b style="width:62%"></b></span>
          <span class="art-bullet"><i></i><b style="width:70%"></b></span>
        </div>
      </div>
    </div>`;
  }
  // General resource: a browser window showing the site it links to.
  if (r.kind === 'general') {
    let host = '';
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
    return `<div class="res-cover res-art" aria-hidden="true">
      <div class="art-browser">
        <div class="art-browser-bar"><i></i><i></i><i></i><span>${esc(host || 'link')}</span></div>
        <div class="art-browser-page">
          <span class="art-slide-title">${esc(r.title)}</span>
          <b style="width:88%"></b><b style="width:70%"></b>
        </div>
      </div>
    </div>`;
  }
  // Study & Prep: an event guidelines document with a checklist.
  const isPdf = /\.pdf($|[?#])/i.test(r.url || '');
  return `<div class="res-cover res-art" aria-hidden="true">
    <div class="art-doc">
      ${isPdf ? '<span class="art-pdf">PDF</span>' : ''}
      <span class="res-page-tag">${esc(tag || 'Study guide')}</span>
      <span class="art-doc-title">${esc(r.title)}</span>
      <span class="art-check"><i></i><b style="width:84%"></b></span>
      <span class="art-check"><i></i><b style="width:66%"></b></span>
      <span class="art-check"><i></i><b style="width:76%"></b></span>
    </div>
  </div>`;
}
// "Open PDF" for PDFs; "Open in Canva" and the like for known sites; plain
// "Open" when the address is too long to be useful (file-hosting links).
function openLabel(url, source) {
  if (/\.pdf($|[?#])/i.test(url || '')) return 'Open PDF';
  return source && source.length <= 22 ? `Open in ${esc(source)}` : 'Open';
}
function resourceCard(r) {
  const href = safeUrl(r.url);
  const tag = r.competitive_event || r.event_name || '';
  const source = href ? linkSource(r.url) : '';
  const inner = `
    ${resourceCover(r, tag)}
    <div class="res-body">
      <span class="res-kicker">${esc(tag || kindInfo(r.kind).one)}</span>
      <h2 class="res-title">${esc(r.title)}</h2>
      ${r.description ? `<p class="res-desc">${esc(r.description)}</p>` : ''}
      <div class="res-foot">
        <span class="res-open">${href ? `${openLabel(r.url, source)} ${icon('external')}` : 'Link coming soon'}</span>
        <span class="res-date">${esc(postedLabel(r.created_at))}</span>
      </div>
    </div>`;
  return href
    ? `<a class="res-card" href="${href}" target="_blank" rel="noopener">${inner}<span class="sr-only"> (opens in a new tab)</span></a>`
    : `<article class="res-card res-card-nolink">${inner}</article>`;
}
function formCard(f) {
  const href = safeUrl(f.url);
  const past = f.due_date && f.due_date < todayISO();
  const inner = `
    <div class="res-cover res-art" aria-hidden="true">
      <div class="art-form">
        <span class="art-form-title">${esc(f.title)}</span>
        <span class="art-form-q"></span>
        <span class="art-radio"><i></i><b style="width:46%"></b></span>
        <span class="art-radio"><i></i><b style="width:38%"></b></span>
        <span class="art-form-q" style="width:52%"></span>
        <span class="art-input"></span>
        <span class="art-submit">Submit</span>
      </div>
    </div>
    <div class="res-body">
      <span class="res-kicker">${f.required ? '<span class="req-tag">Required</span>' : ''}${esc(f.event_name || 'Google Form')}</span>
      <h2 class="res-title">${esc(f.title)}${reqMark(f)}</h2>
      ${f.description ? `<p class="res-desc">${esc(f.description)}</p>` : ''}
      <div class="res-foot">
        <span class="res-open">${href ? `Open form ${icon('external')}` : 'Link coming soon'}</span>
        ${f.due_date ? `<span class="form-due ${past ? 'past' : ''}">${icon('clock')}${past ? 'Was due' : 'Due'} ${esc(shortDate(f.due_date))}</span>` : ''}
      </div>
    </div>`;
  return href
    ? `<a class="res-card" href="${href}" target="_blank" rel="noopener">${inner}<span class="sr-only"> (opens in a new tab)</span></a>`
    : `<article class="res-card res-card-nolink">${inner}</article>`;
}
function tabs(labels, selected, action, label) {
  return `<div class="tabs" role="group" aria-label="${esc(label)}">${labels.map(l => `<button class="tab ${selected === l ? 'active' : ''}" data-action="${action}" data-value="${esc(l)}" aria-pressed="${selected === l}" type="button">${esc(l)}</button>`).join('')}</div>`;
}

// ---------- "new" tracking for the bell (per device) ----------
function seenSet() {
  try { return new Set(JSON.parse(store.get('fbla_hub_seen') || '[]')); } catch (e) { return new Set(); }
}
const updateKeys = () => [
  ...(D().announcements || []).map(a => 'a' + a.id),
  ...(D().forms || []).map(f => 'f' + f.id),
];
function isNewUpdate(a) {
  // The very first visit on a device baselines everything, so nothing is "new".
  if (store.get('fbla_hub_seen') === null) return false;
  return !seenSet().has('a' + a.id);
}
function markUpdatesSeen() {
  store.set('fbla_hub_seen', JSON.stringify(updateKeys().slice(0, 400)));
  updateBell();
}
function updateBell() {
  const dot = $('#bell-dot');
  if (!dot) return;
  if (store.get('fbla_hub_seen') === null) { markUpdatesSeen(); return; }
  const seen = seenSet();
  dot.hidden = !updateKeys().some(k => !seen.has(k));
}

// ---------- navigation ----------
function renderNav() {
  const groups = [['Overview', NAV.slice(0, 4)], ['Resources', NAV.slice(4, 7)]];
  const link = ([id, ic, title]) => `<a href="#${id}" class="m-nav-item ${state.page === id ? 'active' : ''}" ${state.page === id ? 'aria-current="page"' : ''} title="${esc(title)}">${icon(ic)}<span>${esc(title)}</span></a>`;
  $('#navigation').innerHTML = groups.map(([label, items]) =>
    `<p class="m-nav-label">${label}</p><nav class="m-nav" aria-label="${label}">${items.map(link).join('')}</nav>`).join('') +
    `<p class="m-nav-label">Chapter</p><nav class="m-nav" aria-label="Chapter"><a href="/about" data-action="about" class="m-nav-item" title="About the Chapter">${icon('about')}<span>About the Chapter</span></a></nav>`;
  $('#mobile-navigation').innerHTML = NAV.slice(0, 4).map(([id, ic, title]) =>
    `<a href="#${id}" class="${state.page === id ? 'active' : ''}" ${state.page === id ? 'aria-current="page"' : ''}>${icon(ic)}${esc(title)}</a>`).join('') +
    `<button id="mobile-more" class="${NAV.slice(4).some(([id]) => id === state.page) ? 'active' : ''}" data-action="more-menu" type="button" aria-label="More pages" aria-haspopup="true" aria-expanded="false" aria-controls="m-more-menu">${icon('menu')}More</button>`;
  // The phone "More" menu (V1's pop-up above the bottom-right corner): the
  // pages that don't fit in the bottom bar, plus help and officer sign-in.
  const moreLink = ([id, ic, title]) => `<a href="#${id}" class="${state.page === id ? 'active' : ''}" ${state.page === id ? 'aria-current="page"' : ''}>${icon(ic)}${esc(title)}</a>`;
  $('#m-more-menu').innerHTML = NAV.slice(4).map(moreLink).join('') +
    `<a href="/about" data-action="about">${icon('about')}About the Chapter</a>` +
    `<span class="m-more-sep" role="separator"></span>` +
    `<button type="button" data-action="officers">${icon('help')}Need help?</button>` +
    `<button type="button" data-action="officer-login">${icon('lock')}Officer sign in</button>`;
}
function openMoreMenu() {
  const menu = $('#m-more-menu');
  menu.hidden = false;
  $('#mobile-more').setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('a,button');
  if (first) first.focus();
}
function closeMoreMenu(returnFocus = false) {
  const menu = $('#m-more-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const more = $('#mobile-more');
  if (more) { more.setAttribute('aria-expanded', 'false'); if (returnFocus) more.focus(); }
}

// ---------- pages ----------
function countdownBanners() {
  const list = D().countdowns || [];
  if (!list.length) return '';
  return `<div class="m-countdowns">${list.map(c => {
    const target = new Date(`${c.date}T${c.time || '00:00'}:00`).getTime();
    const ev = eventById(c.id);
    const when = `${dateLabel(c.date)}${c.time ? ', ' + fmtTime(c.time) : ''}`;
    return `<div class="m-countdown">
      <button class="m-countdown-copy" data-action="event" data-id="${c.id}" type="button"><strong>${esc(c.name)}</strong><span class="m-cd-when">${esc(when)}</span></button>
      <div class="m-countdown-clock" data-target="${Number.isFinite(target) ? target : 0}" role="timer" aria-label="Time until ${esc(c.name)}"></div>
    </div>`;
  }).join('')}</div>`;
}
// Every live countdown on the page (the banners at the top of Home and the one
// in the blue "Coming up" card) ticks from here. `data-done` is what a clock
// says once its moment has passed.
function tickCountdowns() {
  document.querySelectorAll('[data-target]').forEach(el => {
    const seconds = Math.max(0, Math.floor((Number(el.dataset.target) - Date.now()) / 1000));
    if (!seconds) { el.innerHTML = `<span class="m-cd-now">${esc(el.dataset.done || 'Happening now')}</span>`; return; }
    const values = [Math.floor(seconds / 86400), Math.floor(seconds % 86400 / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
    el.innerHTML = values.map((n, i) => `<span class="m-cd-unit"><span class="m-cd-n">${String(n).padStart(2, '0')}</span><span class="m-cd-l">${['days', 'hrs', 'min', 'sec'][i]}</span></span>`).join('');
  });
}

// The big blue card: the officers' own message when they wrote one, otherwise
// the next chapter meeting (or, failing that, the next thing on the calendar).
function priorityCard() {
  const c = cfg();
  if ((c.home_card_title || '').trim() || (c.home_card_desc || '').trim()) {
    const link = safeUrl(c.home_card_link);
    const label = (c.home_card_button || '').trim() || 'View the calendar';
    return `<article class="m-priority-card">
      <div class="m-eyebrow"><span class="m-live-dot"></span>FROM YOUR OFFICERS</div>
      <h2>${esc((c.home_card_title || '').trim() || 'A note from your officers')}</h2>
      ${(c.home_card_desc || '').trim() ? `<p>${esc(c.home_card_desc)}</p>` : ''}
      ${link
        ? `<a class="m-btn-light" href="${link}" target="_blank" rel="noopener">${esc(label)} →</a>`
        : `<a class="m-btn-light" href="#calendar">${esc(label)} →</a>`}
    </article>`;
  }
  const next = upcoming();
  const meeting = next.find(x => x.kind === 'meeting') || next[0];
  if (!meeting) {
    return `<article class="m-priority-card">
      <div class="m-eyebrow"><span class="m-live-dot"></span>CHAPTER CALENDAR</div>
      <h2>Nothing is scheduled yet</h2>
      <p>New meetings and events show up here as soon as the officers add them. In the meantime, read about what the chapter does.</p>
      <a class="m-btn-light" href="/about" data-action="about">About the chapter →</a>
    </article>`;
  }
  const isMeeting = meeting.kind === 'meeting';
  // Count down to the start (its time, or the start of the day if it has none).
  // Once it has started: a multi-day item is "happening now"; a single-day one
  // is simply today.
  const target = new Date(`${meeting.date}T${meeting.time || '00:00'}:00`).getTime();
  const done = meeting.end_date && meeting.end_date >= todayISO() ? 'Happening now' : 'Today';
  return `<article class="m-priority-card">
    <div class="m-eyebrow"><span class="m-live-dot"></span>${isMeeting ? 'NEXT CHAPTER MEETING' : 'COMING UP'}</div>
    <h2>${esc(meeting.title)}</h2>
    ${meeting.description ? `<p>${esc(meeting.description)}</p>` : ''}
    <div class="m-priority-meta">
      <span>${icon('calendar')}${esc(dateLabel(meeting.date))}${meeting.end_date ? ` to ${esc(dateLabel(meeting.end_date))}` : ''}</span>
      ${meeting.time ? `<span>${icon('clock')}${esc(fmtTime(meeting.time))}</span>` : ''}
      ${meeting.location ? `<span>${icon('location')}${esc(meeting.location)}</span>` : ''}
    </div>
    <div class="m-priority-countdown" data-target="${Number.isFinite(target) ? target : 0}" data-done="${done}" role="timer" aria-label="Time until ${esc(meeting.title)}"></div>
    <button class="m-btn-light" data-action="item" data-id="${esc(meeting.key)}" type="button">View ${isMeeting ? 'meeting ' : ''}details →</button>
  </article>`;
}

function renderHome() {
  const d = D();
  const dateChip = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const next = upcoming();
  const in30 = (() => { const t = new Date(); t.setDate(t.getDate() + 30); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; })();
  const soon = next.filter(c => c.date <= in30).length;
  const meetingRes = (d.resources || []).filter(r => r.kind === 'slideshow');
  const studyRes = (d.resources || []).filter(r => r.kind === 'resource');
  const forms = d.forms || [];
  const anns = (d.announcements || []).slice(0, 3);
  return `${countdownBanners()}
  ${heading(`Welcome to ${esc(chapterName())}.`, "Here's what is happening in FBLA this week.", `<span class="m-date-chip">${icon('calendar')}${esc(dateChip)}</span>`)}
  <section class="m-priority-grid">
    ${priorityCard()}
    <article class="public-prep-card">
      <div class="m-card-top"><p class="m-kicker">Study &amp; Prep</p><span class="public-prep-icon">${icon('book')}</span></div>
      <h2>Prepare for your event</h2>
      <p>Search the chapter's guides, practice materials, and conference prep.</p>
      <a href="#prep" class="button secondary">Browse resources →</a>
    </article>
  </section>
  <section class="m-metrics" aria-label="Chapter shortcuts">
    <a class="m-metric" href="#calendar"><div class="m-metric-top"><span class="m-metric-icon blue">${icon('calendar')}</span><span class="m-mini-tag good">Next 30 days</span></div><h3>Upcoming dates</h3><p><b>${soon} ${soon === 1 ? 'date' : 'dates'}</b> on the chapter calendar</p></a>
    <a class="m-metric" href="#forms"><div class="m-metric-top"><span class="m-metric-icon amber">${icon('file')}</span>${forms.length ? `<span class="m-mini-tag notice">${forms.length} open</span>` : ''}</div><h3>Forms</h3><p>${forms.length ? `<b>${forms.length} Google ${forms.length === 1 ? 'Form' : 'Forms'}</b> from the chapter` : 'No forms right now'}</p></a>
    <a class="m-metric" href="#resources"><div class="m-metric-top"><span class="m-metric-icon purple">${icon('slides')}</span></div><h3>Meeting Resources</h3><p>${meetingRes.length ? `<b>${meetingRes.length}</b> meeting ${meetingRes.length === 1 ? 'resource' : 'resources'}` : 'Slides, agendas, and chapter guides'}</p></a>
    <a class="m-metric" href="#prep"><div class="m-metric-top"><span class="m-metric-icon green">${icon('book')}</span></div><h3>Study &amp; Prep</h3><p>${studyRes.length ? `<b>${studyRes.length}</b> study ${studyRes.length === 1 ? 'material' : 'materials'}` : 'Guides and practice materials'}</p></a>
  </section>
  <section class="m-content-grid">
    <article class="m-section-card">${sectionHeading('Upcoming events', 'calendar', 'View calendar', 'Meetings, events, and deadlines.')}
      ${next.length ? `<div class="m-event-list">${next.slice(0, 4).map(eventRow).join('')}</div>` : '<p class="m-empty">Nothing is scheduled yet.</p>'}
    </article>
    <article class="m-section-card">${sectionHeading('Announcements', 'updates', 'See all', 'The latest from your chapter.')}
      ${anns.length ? `<div>${anns.map(updateRow).join('')}</div>` : '<p class="m-empty">No announcements yet.</p>'}
    </article>
  </section>
  <section class="m-content-grid">
    <article class="m-section-card">${sectionHeading('Meeting Resources', 'resources', 'See all', 'Agendas, slide decks, and chapter materials.')}
      ${meetingRes.length ? `<div class="m-resource-list">${meetingRes.slice(0, 3).map(resourceRow).join('')}</div>` : '<p class="m-empty">No meeting materials posted yet.</p>'}
    </article>
    <article class="m-section-card">${sectionHeading('Forms', 'forms', 'See all', 'Google Forms from the chapter.')}
      ${forms.length ? `<div class="m-resource-list">${forms.slice(0, 3).map(formRow).join('')}</div>` : '<p class="m-empty">No forms right now.</p>'}
    </article>
  </section>`;
}

// The calendar is V1's member calendar: the month grid (click a day for its
// details), the "Coming up" list, and V1's colors, with a Month/List switch.
const CAL_KIND_CLS = { meeting: 'cal-meeting', event: 'cal-event', deadline: 'cal-deadline', other: 'cal-other' };
function calMeta(kind) {
  const meta = kindMeta(kind);
  return { ...meta, cls: CAL_KIND_CLS[kind] || 'cal-other' };
}
const calStyle = (meta) => (meta.color ? ` style="background:${esc(meta.color)};border-color:${esc(meta.color)};color:#fff;"` : '');
const isMeeting = (c) => c.kind === 'meeting';
const DAY_ICONS = {
  meeting: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="5" r="2.2"/><circle cx="11" cy="5" r="2.2"/><path d="M1.5 13c0-2.2 1.6-3.7 3.5-3.7S8.5 10.8 8.5 13M7.5 13c0-2.2 1.6-3.7 3.5-3.7s3.5 1.5 3.5 3.7"/></svg>',
  event: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 14.5V2m0 .5h8l-1.8 3 1.8 3h-8"/></svg>',
  deadline: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/></svg>',
  other: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6"/></svg>',
};
// One entry inside a day of the month grid.
function dayEntry(it, ds) {
  const kind = isMeeting(it) ? 'meeting' : (BUILTIN_KINDS[it.kind] ? it.kind : 'other');
  const meta = kindMeta(it.kind);
  const cont = it.date !== ds;
  const style = meta.color && kind === 'other' ? ` style="--entry:${esc(meta.color)}"` : '';
  return `<div class="day-entry k-${kind} ${cont ? 'is-cont' : ''}"${style} title="${esc(it.title)}${it.time ? ', ' + esc(fmtTime(it.time)) : ''}">
    <span class="day-entry-icon">${DAY_ICONS[kind]}</span>
    <span class="day-entry-text"><span class="day-entry-title">${cont ? '› ' : ''}${esc(it.title)}</span>${it.time && !cont ? `<span class="day-entry-time">${esc(fmtTime(it.time))}</span>` : ''}</span>
  </div>`;
}
function calendarGridHTML() {
  const y = state.year, m = state.month;
  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = todayISO();
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell cal-blank"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayItems = itemsOn(ds);
    const shown = dayItems.slice(0, 2);
    cells += `<div class="cal-cell cal-clickable ${ds === today ? 'cal-today' : ''} ${dayItems.length ? 'has-items' : ''}" data-action="cal-day" data-value="${ds}" role="button" tabindex="0" aria-label="${esc(dateLabel(ds))}${dayItems.length ? `, ${dayItems.length} ${dayItems.length === 1 ? 'item' : 'items'}: ${esc(dayItems.map(i => i.title).join(', '))}` : ''}">
      <div class="cal-daynum">${d}</div>
      ${dayItems.length ? `<div class="day-entries">${shown.map(it => dayEntry(it, ds)).join('')}${dayItems.slice(2).map(it => dayEntry(it, ds).replace('class="day-entry ', 'class="day-entry is-extra ')).join('')}${dayItems.length > shown.length ? `<div class="day-more">+${dayItems.length - shown.length} more</div>` : ''}</div>` : ''}
    </div>`;
  }
  return `
    <div class="cal-grid cal-dow">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>`;
}
function calLegend() {
  const kinds = [['meeting', 'Meeting'], ['event', 'Event'], ['deadline', 'Deadline'], ['other', 'Other']];
  return `<div class="day-legend">${kinds.map(([k, l]) => `<span class="k-${k}"><span class="day-entry-icon">${DAY_ICONS[k]}</span>${l}</span>`).join('')}${customTypes().map(t => `<span class="k-other" style="--entry:${esc(t.color || '#1462d9')}"><span class="day-entry-icon">${DAY_ICONS.other}</span>${esc(t.label)}</span>`).join('')}</div>`;
}
function calListRow(c) {
  const meta = calMeta(c.kind);
  return `<li>
    <span class="m-cal-date">${esc(shortDate(c.date))}${c.end_date ? ' to ' + esc(shortDate(c.end_date)) : ''}${c.time ? ', ' + esc(fmtTime(c.time)) : ''}</span>
    <span class="cal-item ${meta.cls}" style="position:static;${meta.color ? `background:${esc(meta.color)};border-color:${esc(meta.color)};color:#fff;` : ''}">${esc(meta.label)}</span>
    <span class="m-cal-title">${esc(c.title)}</span>
    ${c.location || c.description ? `<span class="m-cal-desc">${esc([c.location, c.description].filter(Boolean).join(' · '))}</span>` : ''}
  </li>`;
}
function renderCalendar() {
  const monthKey = `${state.year}-${String(state.month + 1).padStart(2, '0')}`;
  const monthItems = calendarItems().filter(c => c.date && (c.date.startsWith(monthKey) || (c.end_date && c.date < monthKey && c.end_date >= monthKey)));
  const soon = upcoming().slice(0, 10);
  const nav = `
    <div class="cal-head">
      <button class="btn small secondary" type="button" data-action="month-prev" aria-label="Previous month">&lsaquo; Prev</button>
      <div class="cal-title" aria-live="polite">${MONTHS[state.month]} ${state.year}</div>
      <button class="btn small secondary" type="button" data-action="month-next" aria-label="Next month">Next &rsaquo;</button>
    </div>`;
  const toggle = `<div class="cal-page-actions"><button class="button secondary" type="button" data-action="add-calendar">${icon('calendar')}Add to your calendar</button>${tabs(['Month', 'List'], state.calendarView === 'month' ? 'Month' : 'List', 'calendar-view', 'Calendar display')}</div>`;
  if (state.calendarView === 'list') {
    return `${heading('Calendar', 'Meetings, events, and deadlines in one place.', toggle)}
    <section class="m-section-card">
      ${nav}
      ${monthItems.length ? `<ul class="m-cal-list">${monthItems.map(calListRow).join('')}</ul>` : `<p class="m-empty">Nothing scheduled in ${MONTHS[state.month]}.</p>`}
    </section>`;
  }
  return `${heading('Calendar', 'Meetings, events, and deadlines in one place.', toggle)}
  <section class="m-section-card">
    ${nav}
    ${calendarGridHTML()}
    ${calLegend()}
  </section>
  <section class="m-section-card">
    <div class="m-section-head"><div><h2>Coming up</h2></div></div>
    ${soon.length ? `<ul class="m-cal-list">${soon.map(calListRow).join('')}</ul>` : '<p class="m-empty">Nothing scheduled yet.</p>'}
  </section>`;
}

// ---- Add to your calendar (subscribe to the chapter calendar) ----
function showAddToCalendar() {
  const https = `${location.origin}/calendar.ics`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  const outlook = `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(chapterName())}`;
  openPlainDialog('Add to your calendar', `
    <p>Subscribe once and every chapter meeting, event, and deadline shows up in your own calendar. New dates appear on their own.</p>
    <div class="cal-sub-list">
      <a class="cal-sub" href="${esc(google)}" target="_blank" rel="noopener"><strong>Google Calendar</strong><span>Opens Google Calendar to add it</span></a>
      <a class="cal-sub" href="${esc(webcal)}"><strong>iPhone, iPad, or Mac</strong><span>Opens the Calendar app</span></a>
      <a class="cal-sub" href="${esc(outlook)}" target="_blank" rel="noopener"><strong>Outlook</strong><span>Opens Outlook on the web</span></a>
      <a class="cal-sub" href="/calendar.ics?download=1" download><strong>Download a file</strong><span>A one-time copy (.ics) for any calendar app</span></a>
    </div>`);
}

// ---- Day popover: click a date to see its items next to the cell (V1) ----
function closeCalPopover() {
  const pop = document.getElementById('cal-popover');
  if (pop) pop.remove();
  document.removeEventListener('click', calPopoverOutside, true);
}
function calPopoverOutside(e) {
  const pop = document.getElementById('cal-popover');
  if (pop && !pop.contains(e.target)) closeCalPopover();
}
function showCalDayPopover(ds, cell) {
  closeCalPopover();
  const dayItems = itemsOn(ds);
  const label = new Date(ds + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  // A plain agenda: time on the left, what and where on the right.
  const rows = dayItems.map(it => {
    const kind = isMeeting(it) ? 'meeting' : (BUILTIN_KINDS[it.kind] ? it.kind : 'other');
    const meta = kindMeta(it.kind);
    const style = meta.color && kind === 'other' ? ` style="--entry:${esc(meta.color)}"` : '';
    const when = it.end_date ? `${esc(shortDate(it.date))} to ${esc(shortDate(it.end_date))}` : '';
    return `<div class="day-pop-row k-${kind}"${style}>
      <div class="day-pop-time">${it.time ? esc(fmtTime(it.time)) : 'All day'}</div>
      <div class="day-pop-body">
        <div class="day-pop-title">${esc(it.title)}</div>
        <div class="day-pop-meta"><span class="day-pop-kind"><span class="day-entry-icon">${DAY_ICONS[kind]}</span>${esc(kind === 'meeting' ? 'Meeting' : meta.label)}</span>${it.location ? `<span>${esc(it.location)}</span>` : ''}${when ? `<span>${when}</span>` : ''}</div>
        ${it.description ? `<div class="day-pop-desc">${esc(it.description)}</div>` : ''}
        ${it.key ? `<button class="day-pop-add" type="button" data-action="download-item" data-id="${esc(it.key)}">Add to my calendar</button>` : ''}
      </div>
    </div>`;
  }).join('');
  const pop = document.createElement('div');
  pop.id = 'cal-popover';
  pop.className = 'cal-popover day-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  pop.innerHTML = `
    <div class="day-pop-head">
      <span>${esc(label)}</span>
      <button class="cal-pop-close" type="button" data-action="cal-pop-close" aria-label="Close">×</button>
    </div>
    ${rows || '<div class="day-pop-empty">Nothing on this day.</div>'}`;
  document.body.appendChild(pop);
  // Position beside the clicked cell, clamped to the viewport.
  const r = cell.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.right + 8;
  if (left + pw > window.innerWidth - 10) left = r.left - pw - 8;
  if (left < 10) left = Math.max(10, Math.min(window.innerWidth - pw - 10, r.left));
  let top = r.top;
  if (top + ph > window.innerHeight - 10) top = Math.max(10, window.innerHeight - ph - 10);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.querySelector('.cal-pop-close').focus();
  setTimeout(() => document.addEventListener('click', calPopoverOutside, true), 0);
}

function renderForms() {
  const forms = D().forms || [];
  return `${heading('Forms', 'Google Forms from the chapter.')}
  <section class="m-section-card">
    ${forms.length ? `<div class="m-res-grid">${forms.map(formCard).join('')}</div>` : '<div class="empty-state"><h2>No forms right now.</h2></div>'}
  </section>`;
}

function renderUpdates() {
  const all = D().announcements || [];
  const cats = ['All', ...new Set(all.map(a => a.category || 'Chapter news'))];
  if (!cats.includes(state.updateFilter)) state.updateFilter = 'All';
  const list = all.filter(a => state.updateFilter === 'All' || (a.category || 'Chapter news') === state.updateFilter);
  return `${heading('Announcements', 'The latest from your chapter, pinned items first.')}
  ${cats.length > 2 ? `<div class="page-toolbar">${tabs(cats, state.updateFilter, 'update-filter', 'Announcement category')}</div>` : ''}
  <div class="updates-page">${list.map(a => `
    <section class="m-section-card ${a.pinned ? 'm-pinned' : ''}">
      <div class="m-ann">
        <h2 class="m-ann-title">${a.pinned ? icon('pin') : ''}${esc(a.title)}</h2>
        ${a.body ? `<div class="m-ann-body">${esc(a.body)}</div>` : ''}
        <div class="m-ann-meta"><span>${esc(postedLabel(a.created_at))}</span><span aria-hidden="true">·</span><span>${esc(a.category || 'Chapter news')}</span></div>
      </div>
    </section>`).join('') || '<section class="m-section-card"><p class="m-empty">No announcements yet.</p></section>'}</div>`;
}

function resourceResults() {
  const q = state.resourceQuery.trim().toLowerCase();
  const found = (D().resources || []).filter(r => r.kind === 'slideshow' &&
    (!q || `${r.title} ${r.description || ''} ${r.event_name || ''}`.toLowerCase().includes(q)));
  return found.map(resourceCard).join('') || (q
    ? '<div class="empty-state"><h2>No matching resources.</h2></div>'
    : '<div class="empty-state"><h2>No meeting materials yet.</h2></div>');
}
function renderResources() {
  return `${heading('Meeting Resources', 'Agendas, slide decks, and materials from chapter meetings.')}
  <section class="m-section-card">
    <div class="page-toolbar"><label class="input-wrap">${icon('search')}<input id="resource-search" type="search" placeholder="Search meeting resources" value="${esc(state.resourceQuery)}" aria-label="Search meeting resources" /></label></div>
    <div class="m-res-grid" id="resource-results">${resourceResults()}</div>
  </section>`;
}

// ---------- Study & Prep ----------
// Materials tagged "All Events" (topics lists and other references that cover
// every event) sit in their own section at the top; each event's own guides
// follow under "Individual Events". The search box filters both.
const ALL_EVENTS_TAG = 'all events';
function prepResults() {
  const q = state.prepQuery.trim().toLowerCase();
  const found = (D().resources || []).filter(r => r.kind === 'resource' &&
    (!q || `${r.title} ${r.description || ''} ${r.competitive_event || ''} ${r.event_name || ''}`.toLowerCase().includes(q)));
  if (!found.length) {
    return q
      ? '<div class="empty-state"><h2>No matching materials.</h2></div>'
      : '<div class="empty-state"><h2>No study materials yet.</h2></div>';
  }
  const isAll = (r) => (r.competitive_event || '').trim().toLowerCase() === ALL_EVENTS_TAG;
  const all = found.filter(isAll);
  const each = found.filter(r => !isAll(r));
  const section = (title, list) => list.length ? `
    <div class="prep-section">
      <h2 class="prep-section-title">${title} <span>${list.length}</span></h2>
      <div class="m-res-grid">${list.map(resourceCard).join('')}</div>
    </div>` : '';
  return section('All Events', all) + section('Individual Events', each);
}
function renderPrep() {
  return `${heading('Study &amp; Prep', 'Competitive-event guides, conference prep, and chapter study materials.')}
  <section class="m-section-card">
    <div class="page-toolbar"><label class="input-wrap">${icon('search')}<input id="prep-search" type="search" placeholder="Search study materials, e.g. an event name" value="${esc(state.prepQuery)}" aria-label="Search study materials" /></label></div>
    <div id="prep-results">${prepResults()}</div>
  </section>`;
}

// ---------- General Resources ----------
function generalResults() {
  const q = state.generalQuery.trim().toLowerCase();
  const found = (D().resources || []).filter(r => r.kind === 'general' &&
    (!q || `${r.title} ${r.description || ''} ${r.event_name || ''}`.toLowerCase().includes(q)));
  return found.map(resourceCard).join('') || (q
    ? '<div class="empty-state"><h2>No matching resources.</h2></div>'
    : '<div class="empty-state"><h2>No general resources yet.</h2></div>');
}
function renderGeneral() {
  return `${heading('General Resources', 'Chapter guides, links, and other useful materials.')}
  <section class="m-section-card">
    <div class="page-toolbar"><label class="input-wrap">${icon('search')}<input id="general-search" type="search" placeholder="Search general resources" value="${esc(state.generalQuery)}" aria-label="Search general resources" /></label></div>
    <div class="m-res-grid" id="general-results">${generalResults()}</div>
  </section>`;
}

function render({ focus = false } = {}) {
  renderNav();
  const title = PAGE_TITLES[state.page] || 'Home';
  $('#breadcrumb').textContent = title;
  document.title = `${title} · ${chapterName()}`;
  const pages = { home: renderHome, calendar: renderCalendar, forms: renderForms, updates: renderUpdates, resources: renderResources, prep: renderPrep, general: renderGeneral };
  const main = $('#main');
  main.innerHTML = (pages[state.page] || renderHome)();
  main.setAttribute('aria-busy', 'false');
  tickCountdowns();
  if (focus) main.focus({ preventScroll: true });
}
function renderError() {
  const main = $('#main');
  main.setAttribute('aria-busy', 'false');
  main.innerHTML = `<div class="hub-error"><h1>This page didn't load.</h1><p>Check your connection and try again. If it keeps happening, let an officer know.</p><button class="button" data-action="retry" type="button">Try again</button></div>`;
}

function route() {
  closeCalPopover();
  const page = location.hash.slice(1).split('/')[0];
  state.page = PAGE_TITLES[page] ? page : 'home';
  hideHubSearch();
  closeMenu();
  if (state.data) render({ focus: !!location.hash });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

let lastPayload = '';
async function load() {
  let text;
  try {
    const res = await fetch('/api/public/hub', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
    // A background refresh with nothing new must not re-render the page (that
    // would wipe whatever a visitor is typing into a search box).
    if (state.data && text === lastPayload) return;
    state.data = JSON.parse(text);
    lastPayload = text;
  } catch (e) {
    if (!state.data) renderError();
    return;
  }
  applyBranding();
  updateBell();
  render();
  maybePopupForm();
}

// ---------- pop-up forms ----------
// Officers can make a Google Form pop up when someone opens the site. There
// are no accounts, so the choice is remembered on this device only:
//   "I've filled it out" -> never pop this form up again here
//   "Remind me later"    -> not again until the next visit (this browser tab)
const POPUP_DONE_KEY = 'fbla_popup_done';
const popupDone = () => { try { return new Set(JSON.parse(store.get(POPUP_DONE_KEY) || '[]')); } catch (e) { return new Set(); } };
const popupLater = new Set(JSON.parse((() => { try { return sessionStorage.getItem('fbla_popup_later') || '[]'; } catch (e) { return '[]'; } })()));
function maybePopupForm() {
  if (dialog.open || !$('#about-overlay').classList.contains('hidden')) return;
  const done = popupDone();
  const next = (D().forms || []).find(f => f.popup && safeUrl(f.url) && !done.has(f.id) && !popupLater.has(f.id));
  if (!next) return;
  const past = next.due_date && next.due_date < todayISO();
  const meta = [next.required ? '<span class="req-note">Required</span>' : '', next.event_name ? esc(next.event_name) : '', next.due_date ? `${past ? 'Was due' : 'Due'} ${esc(shortDate(next.due_date))}` : ''].filter(Boolean);
  openPlainDialog(esc(next.title), `
    ${next.description ? `<p>${esc(next.description)}</p>` : ''}
    ${meta.length ? `<p class="plain-meta">${meta.join(' · ')}</p>` : ''}
    <div class="plain-actions">
      <a class="button" href="${safeUrl(next.url)}" target="_blank" rel="noopener" data-action="popup-open" data-id="${next.id}">Open form<span class="sr-only"> (opens in a new tab)</span></a>
      <button class="button secondary" type="button" data-action="popup-later" data-id="${next.id}">Not now</button>
    </div>
    <button class="plain-link" type="button" data-action="popup-done" data-id="${next.id}">I already filled this out</button>`);
  const openBtn = dialog.querySelector('[data-action="popup-open"]');
  if (openBtn) openBtn.focus();
}
function dismissPopup(id, forever) {
  const fid = Number(id);
  if (forever) {
    const done = popupDone(); done.add(fid);
    store.set(POPUP_DONE_KEY, JSON.stringify([...done].slice(-200)));
  } else {
    popupLater.add(fid);
    try { sessionStorage.setItem('fbla_popup_later', JSON.stringify([...popupLater])); } catch (e) { /* storage blocked: fine */ }
  }
  closeDialog();
  // One at a time: show the next pop-up form, if there is one.
  setTimeout(maybePopupForm, 250);
}
function applyBranding() {
  const name = chapterName();
  document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = name; });
  const hero = $('#about-hero-title'); if (hero) hero.textContent = name;
}

// ---------- dialog ----------
const dialog = $('#dialog');
let returnFocus = null;
function openDialog(kicker, title, body) {
  if (!dialog.open) returnFocus = document.activeElement;
  dialog.classList.remove('is-plain');
  $('#dialog-content').innerHTML = `<div class="dialog-header"><p class="eyebrow">${kicker || ''}</p><button class="icon-button" data-action="dialog-close" type="button" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body"><h2 id="dialog-title">${title}</h2>${body}</div>`;
  if (!dialog.open) dialog.showModal();
  document.body.style.overflow = 'hidden';
  const first = dialog.querySelector('input:not([type=hidden]), .dialog-body button, .dialog-body a, button');
  if (first) first.focus();
}
// A plainer dialog: just a title, a close button, and the content.
function openPlainDialog(title, body) {
  openDialog('', title, body);
  dialog.classList.add('is-plain');
}
function closeDialog() {
  if (!dialog.open) return;
  dialog.close();
  document.body.style.overflow = '';
  if (returnFocus && returnFocus.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus();
  else $('#main').focus({ preventScroll: true });
}
dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const r = dialog.getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog();
});

function paymentFacts(e) {
  if (!e) return '';
  const rows = [];
  if (Number(e.cost_per_member) > 0) rows.push(`<div><dt>First payment</dt><dd>$${Number(e.cost_per_member).toFixed(2)}${e.first_payment_due ? `, due ${esc(dateLabel(e.first_payment_due))}` : ''}</dd></div>`);
  if (e.second_payment_enabled && Number(e.second_payment_amount) > 0) rows.push(`<div><dt>Second payment</dt><dd>$${Number(e.second_payment_amount).toFixed(2)}${e.second_payment_due ? `, due ${esc(dateLabel(e.second_payment_due))}` : ''}</dd></div>`);
  return rows.join('');
}
function showItem(key) {
  const c = findItem(key);
  if (!c) return;
  const ev = (c.source === 'event' || c.source === 'payment') ? eventById(c.id) : null;
  const meta = kindMeta(c.kind);
  const description = c.source === 'payment' && ev ? ev.description : c.description;
  openDialog(`CHAPTER CALENDAR · ${esc(meta.label.toUpperCase())}`, esc(c.title), `
    ${description ? `<p class="dialog-lead">${esc(description)}</p>` : ''}
    <dl class="dialog-facts">
      <div><dt>Date</dt><dd>${esc(dateLabel(c.date))}${c.end_date ? ` to ${esc(dateLabel(c.end_date))}` : ''}</dd></div>
      <div><dt>Time</dt><dd>${c.time ? esc(fmtTime(c.time)) : 'All day'}</dd></div>
      ${c.location ? `<div><dt>Location</dt><dd>${esc(c.location)}</dd></div>` : ''}
      ${c.source !== 'payment' ? paymentFacts(ev) : ''}
    </dl>
    <div class="dialog-actions">
      <button class="button" data-action="download-item" data-id="${esc(c.key)}" type="button">${icon('download')} Add to my calendar</button>
      ${ev && c.source === 'payment' ? `<button class="button secondary" data-action="event" data-id="${ev.id}" type="button">About ${esc(ev.name)}</button>` : ''}
      <button class="button secondary" data-action="dialog-route" data-value="calendar" type="button">Full calendar</button>
    </div>`);
}
// Countdown banners link to the event itself.
function showEvent(id) {
  const ev = eventById(id);
  if (!ev) return;
  const item = calendarItems().find(c => c.source === 'event' && c.id === ev.id);
  if (item) { showItem(item.key); return; }
  openDialog('CHAPTER EVENT', esc(ev.name), `${ev.description ? `<p class="dialog-lead">${esc(ev.description)}</p>` : ''}<dl class="dialog-facts">${paymentFacts(ev)}</dl>`);
}
function showUpdate(id) {
  const a = (D().announcements || []).find(x => x.id === Number(id));
  if (!a) return;
  openDialog(`${esc((a.category || 'Chapter news').toUpperCase())} · ${esc(postedLabel(a.created_at))}`, esc(a.title), `
    ${a.body ? `<p class="dialog-lead" style="white-space:pre-wrap">${esc(a.body)}</p>` : ''}
    <div class="dialog-actions"><button class="button secondary" data-action="dialog-route" data-value="updates" type="button">All announcements ${icon('arrow')}</button></div>`);
}
// The "Need help?" card: the advisor and the officer team with their emails,
// so a visitor knows who to find at a meeting or write to.
function showOfficers() {
  const team = D().leadership || [];
  const initials = (n) => String(n || '?').trim().split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
  const row = (o) => `<li class="help-person">
      <span class="help-avatar" aria-hidden="true">${esc(initials(o.name))}</span>
      <span class="help-person-copy"><strong>${esc(o.name)}</strong><span>${esc(o.display_title || '')}</span>${o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : ''}</span>
    </li>`;
  const advisors = team.filter(o => o.role === 'advisor');
  const officers = team.filter(o => o.role !== 'advisor');
  openDialog('NEED HELP?', 'Officers and advisors', team.length ? `
    ${advisors.length ? `<h3 class="help-group">${advisors.length === 1 ? 'Advisor' : 'Advisors'}</h3><ul class="help-list">${advisors.map(row).join('')}</ul>` : ''}
    ${officers.length ? `<h3 class="help-group">Officers</h3><ul class="help-list">${officers.map(row).join('')}</ul>` : ''}` : '<p>The officer list will be posted here soon.</p>');
}
function showNotifications() {
  const seen = store.get('fbla_hub_seen') === null ? new Set(updateKeys()) : seenSet();
  const anns = (D().announcements || []).slice(0, 6);
  const newForms = (D().forms || []).filter(f => !seen.has('f' + f.id));
  openDialog('CHAPTER UPDATES', 'The latest from the chapter.', `
    ${newForms.length ? `<p>New ${newForms.length === 1 ? 'form' : 'forms'} to look at:</p><div class="m-resource-list">${newForms.slice(0, 4).map(formRow).join('')}</div>` : ''}
    ${anns.length ? `<div class="updates-list">${anns.map(updateRow).join('')}</div>` : '<p>No announcements yet.</p>'}
    <div class="dialog-actions"><button class="button secondary" data-action="dialog-route" data-value="updates" type="button">All announcements ${icon('arrow')}</button></div>`);
  markUpdatesSeen();
}

// ---------- officer sign-in ----------
async function showOfficerLogin() {
  // Already signed in on this browser: go straight to the console.
  try {
    const me = await (await fetch('/api/me')).json();
    if (me && me.loggedIn) { location.href = '/officer'; return; }
  } catch (e) { /* fall through to the form */ }
  openDialog('', 'Officer sign in', `
    <form id="officer-login-form" novalidate>
      <div class="form-field"><label for="officer-name">Name or email</label><input id="officer-name" name="officer_name" autocomplete="username" aria-describedby="officer-login-error" required /></div>
      <div class="form-field"><label for="officer-password">Password</label><input id="officer-password" name="officer_password" type="password" autocomplete="current-password" aria-describedby="officer-login-error" required /></div>
      <p class="login-dialog-error" id="officer-login-error" role="alert" hidden></p>
      <div class="dialog-actions">
        <button class="button" type="submit">Sign in ${icon('arrow')}</button>
        <a class="text-button" href="/officer?forgot=1">Forgot password?</a>
      </div>
    </form>`);
}
async function submitOfficerLogin(form) {
  const err = $('#officer-login-error');
  const nameInput = form.elements.officer_name;
  const pwInput = form.elements.officer_password;
  const name = nameInput.value.trim();
  const password = pwInput.value;
  [nameInput, pwInput].forEach(i => i.removeAttribute('aria-invalid'));
  // Show the message and put the cursor in the field that needs fixing.
  const fail = (msg, field) => {
    err.textContent = msg;
    err.hidden = false;
    const input = field === 'password' ? pwInput : field === 'name' ? nameInput : null;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      if (field === 'password') input.value = '';
      input.focus();
    }
  };
  if (!name) return fail('Enter your name or email.', 'name');
  if (!password) return fail('Enter your password.', 'password');
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return fail(body.error || 'Sign-in failed. Try again.', body.field);
    location.href = '/officer';
  } catch (e) {
    fail('Could not reach the server. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

// ---------- search ----------
function searchResults(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return '';
  const d = D();
  const all = [
    ...NAV.map(([id, , title]) => ({ title, type: 'Page', action: 'search-route', id })),
    { title: 'About the Chapter', type: 'Page', action: 'about', id: '' },
    ...(d.announcements || []).map(a => ({ title: a.title, text: a.body, type: 'Announcement', action: 'update', id: a.id })),
    ...upcoming().map(c => ({ title: c.title, text: c.description, type: `Calendar · ${shortDate(c.date)}`, action: 'item', id: c.key })),
    ...(d.forms || []).map(f => ({ title: f.title, text: f.description, type: 'Google Form', action: 'open-link', id: f.url })),
    ...(d.resources || []).map(r => ({ title: r.title, text: `${r.description || ''} ${r.competitive_event || ''} ${r.event_name || ''}`, type: kindInfo(r.kind).one, action: r.url ? 'open-link' : 'search-route', id: r.url || kindInfo(r.kind).page })),
  ];
  const found = all.filter(x => `${x.title} ${x.text || ''} ${x.type}`.toLowerCase().includes(q));
  return found.slice(0, 10).map(x => `<button class="search-result" data-action="${x.action}" data-id="${esc(x.id)}" type="button"><span><strong>${esc(x.title)}</strong><small>${esc(x.type)}</small></span>${icon(x.action === 'open-link' ? 'external' : 'arrow')}</button>`).join('') || '<p role="status" style="padding:10px;margin:0;font-size:13px;color:var(--m-muted)">No results. Try another word.</p>';
}
function hideHubSearch() {
  const box = $('#hub-search-results');
  if (box) box.hidden = true;
  const input = $('#hub-search');
  if (input) input.setAttribute('aria-expanded', 'false');
}
function updateHubSearch() {
  const input = $('#hub-search');
  const box = $('#hub-search-results');
  box.hidden = !input.value.trim();
  box.innerHTML = searchResults(input.value);
  input.setAttribute('aria-expanded', String(!box.hidden));
}

// ---------- mobile menu ----------
function closeMenu() {
  closeMoreMenu();
  const sidebar = $('#sidebar');
  sidebar.inert = window.innerWidth <= 780;
  sidebar.classList.remove('open');
  $('.nav-scrim').hidden = true;
  const more = $('#mobile-more');
  if (more) more.setAttribute('aria-expanded', 'false');
  if (!dialog.open) document.body.style.overflow = '';
}

// ---------- add to calendar (.ics, built in the browser) ----------
function downloadItem(key) {
  const c = findItem(key);
  if (!c) return;
  const safe = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const compact = (ds) => ds.replace(/-/g, '');
  const addDay = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//State High FBLA//Calendar//EN', 'BEGIN:VEVENT',
    `UID:${c.source}-${c.id}-${compact(c.date)}@fblahub`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`];
  if (c.time && !c.end_date) {
    const [h, m] = c.time.split(':').map(Number);
    const start = `${compact(c.date)}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    const end = `${compact(c.date)}T${String(Math.min(23, h + 1)).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    lines.push(`DTSTART;TZID=America/New_York:${start}`, `DTEND;TZID=America/New_York:${end}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compact(c.date)}`, `DTEND;VALUE=DATE:${compact(addDay(c.end_date || c.date, 1))}`);
  }
  lines.push(`SUMMARY:${safe(c.title)}`);
  if (c.location) lines.push(`LOCATION:${safe(c.location)}`);
  if (c.description) lines.push(`DESCRIPTION:${safe(c.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${c.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'fbla-event'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Calendar file downloaded. Open it to add the date to your calendar.');
}

let toastTimeout;
function toast(message) {
  clearTimeout(toastTimeout);
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  toastTimeout = setTimeout(() => $('#toast').classList.remove('show'), 4200);
}
function preserveFocusRender(button) {
  const { action, value } = button.dataset;
  render();
  const target = [...document.querySelectorAll('[data-action]')].find(b => b.dataset.action === action && b.dataset.value === value);
  if (target) target.focus({ preventScroll: true });
}

// ---------- About page (V1's About page, opened over the hub) ----------
const ABOUT_PATHS = ['/about', '/aboutfbla'];
let aboutLoaded = false;
let aboutOpenedFromHub = false;
function showAbout(push = true) {
  closeDialog();
  closeMenu();
  hideHubSearch();
  const overlay = $('#about-overlay');
  overlay.classList.remove('hidden');
  $('#chapter-app').inert = true;
  document.body.style.overflow = 'hidden';
  overlay.scrollTop = 0;
  requestAnimationFrame(refreshAboutGalleries);
  if (push && !ABOUT_PATHS.includes(location.pathname)) {
    aboutOpenedFromHub = true;
    try { history.pushState({ about: true }, '', '/about'); } catch (e) { /* ignore */ }
  }
  document.title = `About · ${chapterName()}`;
  if (!aboutLoaded) loadAboutInfo();
  $('#about-back').focus();
}
function hideAbout(fromPop = false) {
  $('#about-overlay').classList.add('hidden');
  $('#chapter-app').inert = false;
  document.body.style.overflow = '';
  if (!fromPop) {
    if (aboutOpenedFromHub) { aboutOpenedFromHub = false; history.back(); return; }
    try { history.replaceState({}, '', '/#home'); } catch (e) { /* ignore */ }
  }
  route();
}
async function loadAboutInfo() {
  const box = $('#about-leadership');
  try {
    const res = await fetch('/api/public/about');
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    aboutLoaded = true;
    if (data.chapter_name) { const h = $('#about-hero-title'); if (h) h.textContent = data.chapter_name; }
    if (!box) return;
    const team = Array.isArray(data.leadership) ? data.leadership : [];
    if (!team.length) {
      box.innerHTML = '<p class="muted">This year\'s officer list will be posted here soon.</p>';
      return;
    }
    // Advisor first: centered above the officer grid, larger card.
    const leaderCard = (o, big) => {
      const initials = (o.name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
      return `<div class="about-leader ${big ? 'about-leader-advisor' : ''}">
        <span class="about-leader-avatar">${esc(initials)}</span>
        <span class="about-leader-text"><strong>${esc(o.name)}</strong><small>${esc(o.display_title || '')}</small></span>
      </div>`;
    };
    const advisors = team.filter(o => o.role === 'advisor');
    const officers = team.filter(o => o.role !== 'advisor');
    box.innerHTML = `${advisors.length ? `<div class="about-advisor-row">${advisors.map(o => leaderCard(o, true)).join('')}</div>` : ''}${officers.map(o => leaderCard(o, false)).join('')}`;
  } catch (e) {
    if (box) box.innerHTML = '<p class="muted">We could not load the officer list. Please try again later.</p>';
  }
}
function setupAboutGalleries() {
  document.querySelectorAll('.about-photo-stop').forEach(section => {
    const track = section.querySelector('.about-photo-grid');
    const previous = section.querySelector('[data-gallery-prev]');
    const next = section.querySelector('[data-gallery-next]');
    if (!track || !previous || !next) return;
    const updateArrows = () => {
      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      previous.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft >= maxScroll - 2;
    };
    const move = (direction) => {
      const firstPhoto = track.querySelector('a');
      if (!firstPhoto) return;
      const gap = parseFloat(getComputedStyle(track).gap) || 0;
      track.scrollBy({ left: direction * (firstPhoto.getBoundingClientRect().width + gap), behavior: 'smooth' });
    };
    previous.onclick = () => move(-1);
    next.onclick = () => move(1);
    track.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    track._updateGalleryArrows = updateArrows;
    updateArrows();
  });
}
function refreshAboutGalleries() {
  document.querySelectorAll('.about-photo-grid').forEach(track => {
    if (typeof track._updateGalleryArrows === 'function') track._updateGalleryArrows();
  });
}

// ---------- events ----------
document.addEventListener('click', (event) => {
  if (event.target.closest('.skip-link')) { event.preventDefault(); $('#main').focus(); return; }
  if (!event.target.closest('.m-search') && !event.target.closest('#hub-search-results')) hideHubSearch();
  // Any tap outside the More menu (or on one of its items) closes it.
  if (!event.target.closest('#mobile-more') && (!event.target.closest('#m-more-menu') || event.target.closest('#m-more-menu a, #m-more-menu button'))) closeMoreMenu();
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, value } = button.dataset;
  switch (action) {
    case 'menu-open': {
      const sidebar = $('#sidebar');
      sidebar.inert = false;
      sidebar.classList.add('open');
      $('.nav-scrim').hidden = false;
      button.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      $('.mobile-close').focus();
      break;
    }
    case 'more-menu': if ($('#m-more-menu').hidden) openMoreMenu(); else closeMoreMenu(true); break;
    case 'menu-close': closeMenu(); { const more = $('#mobile-more'); if (more) more.focus(); } break;
    case 'sidebar-toggle': {
      const collapsed = $('#chapter-app').classList.toggle('nav-collapsed');
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', collapsed ? 'Expand menu' : 'Collapse menu');
      break;
    }
    case 'dialog-close': closeDialog(); break;
    case 'item': hideHubSearch(); showItem(id); break;
    case 'event': showEvent(id); break;
    case 'update': hideHubSearch(); showUpdate(id); break;
    case 'notifications': showNotifications(); break;
    case 'officers': closeMenu(); showOfficers(); break;
    case 'officer-login': closeMenu(); showOfficerLogin(); break;
    case 'about': event.preventDefault(); showAbout(); break;
    case 'open-link': hideHubSearch(); if (/^https?:\/\//i.test(id || '')) window.open(id, '_blank', 'noopener'); break;
    case 'dialog-route': case 'search-route': {
      closeDialog();
      hideHubSearch();
      const input = $('#hub-search'); if (input) input.value = '';
      const target = action === 'search-route' ? id : value;
      if (location.hash === '#' + target) route(); else location.hash = target;
      break;
    }
    case 'retry': $('#main').innerHTML = '<div class="hub-loading">Loading…</div>'; load(); break;
    case 'month-prev': case 'month-next': {
      const d = new Date(state.year, state.month + (action === 'month-prev' ? -1 : 1), 1);
      state.month = d.getMonth(); state.year = d.getFullYear();
      preserveFocusRender(button);
      break;
    }
    case 'calendar-view': state.calendarView = value.toLowerCase(); preserveFocusRender(button); break;
    case 'update-filter': state.updateFilter = value; preserveFocusRender(button); break;
    case 'cal-day': showCalDayPopover(value, button); break;
    case 'cal-pop-close': closeCalPopover(); break;
    case 'download-item': downloadItem(id); break;
    case 'add-calendar': showAddToCalendar(); break;
    // Opening the form counts as "later" (they may not finish it); they can
    // mark it done next time.
    case 'popup-open': dismissPopup(id, false); break;
    case 'popup-done': dismissPopup(id, true); break;
    case 'popup-later': dismissPopup(id, false); break;
    default: break;
  }
});
document.addEventListener('input', (event) => {
  const t = event.target;
  if (t.id === 'hub-search') updateHubSearch();
  if (t.id === 'resource-search') { state.resourceQuery = t.value; $('#resource-results').innerHTML = resourceResults(); }
  if (t.id === 'general-search') { state.generalQuery = t.value; $('#general-results').innerHTML = generalResults(); }
  if (t.id === 'prep-search') { state.prepQuery = t.value; $('#prep-results').innerHTML = prepResults(); }
});
document.addEventListener('submit', (event) => {
  if (event.target.id === 'officer-login-form') { event.preventDefault(); submitOfficerLogin(event.target); }
});
document.addEventListener('keydown', (event) => {
  const day = event.target.closest && event.target.closest('[data-action="cal-day"]');
  if (day && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showCalDayPopover(day.dataset.value, day); return; }
  if (event.key === 'Escape' && document.getElementById('cal-popover')) { closeCalPopover(); return; }
  if (event.key === 'Escape' && !$('#m-more-menu').hidden) { closeMoreMenu(true); return; }
  if (event.key === 'Escape') {
    hideHubSearch();
    if (!$('#about-overlay').classList.contains('hidden') && !dialog.open) { hideAbout(); return; }
    if ($('#sidebar').classList.contains('open')) { closeMenu(); const more = $('#mobile-more'); if (more) more.focus(); }
  }
  // Keep keyboard focus inside the open mobile menu.
  if (event.key === 'Tab' && $('#sidebar').classList.contains('open')) {
    const els = [...$('#sidebar').querySelectorAll('a,button')].filter(el => el.getClientRects().length);
    const first = els[0], last = els[els.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
window.addEventListener('hashchange', route);
window.addEventListener('popstate', () => {
  const onAbout = ABOUT_PATHS.includes(location.pathname);
  const open = !$('#about-overlay').classList.contains('hidden');
  if (onAbout && !open) showAbout(false);
  else if (!onAbout && open) { aboutOpenedFromHub = false; hideAbout(true); }
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 780) closeMenu();
  else if (!$('#sidebar').classList.contains('open')) $('#sidebar').inert = true;
});
function updateOnlineStatus() {
  const banner = $('#offline-banner');
  if (banner) banner.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', () => { updateOnlineStatus(); load(); });
window.addEventListener('offline', updateOnlineStatus);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); }, { once: true });
}

// ---------- start ----------
hydrateIcons();
$('#about-back').addEventListener('click', () => hideAbout());
setupAboutGalleries();
updateOnlineStatus();
closeMenu();
state.page = PAGE_TITLES[location.hash.slice(1).split('/')[0]] ? location.hash.slice(1).split('/')[0] : 'home';
renderNav();
if (ABOUT_PATHS.includes(location.pathname)) showAbout(false);
load();
setInterval(tickCountdowns, 1000);
// Pick up officer edits without a reload when someone leaves the tab open.
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5 * 60 * 1000);
