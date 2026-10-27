// Shared page shell and UI helpers. Every dashboard page renders through
// layout(), so navigation, global filters, theming and accessibility behave
// the same everywhere.

import { STYLES } from "./styles";
import { RANGE_OPTIONS, DEFAULT_RANGE, withFilters, type Filters, type ListState } from "./filters";
import { countConditions, encodeExpr, toWire } from "./domain-filter";
import { FILTER_BAR_JS, FILTER_BUILDER_CSS, FILTER_BUILDER_JS, FILTER_OPS } from "./filter-builder-ui";
import type { LastSync } from "./app-settings";

export const BRAND = "dmarc-compass";

// ---------- formatting ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function fmtNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export function relTime(epochSeconds: number, now = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, now - epochSeconds);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** JSON that is safe to embed inside a <script> element. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

// ---------- DMARC helpers ----------

export type RateTone = "good" | "warn" | "bad";
export function rateTone(rate: number): RateTone {
  if (rate >= 99.9) return "good";
  if (rate >= 90) return "warn";
  return "bad";
}

/** Policy-level (aligned) and auth-level (raw) failures are tracked
 * separately because they point to different root causes. */
export function deriveIssues(r: {
  policy_dkim?: string | null;
  policy_spf?: string | null;
  auth_dkim_result?: string | null;
  auth_spf_result?: string | null;
}): string[] {
  const issues: string[] = [];
  if (r.policy_dkim && r.policy_dkim !== "pass") issues.push("DKIM policy");
  if (r.policy_spf && r.policy_spf !== "pass") issues.push("SPF policy");
  if (r.auth_dkim_result && r.auth_dkim_result !== "pass") issues.push("DKIM auth");
  if (r.auth_spf_result && r.auth_spf_result !== "pass") issues.push("SPF auth");
  return issues;
}

export function issueBadges(issues: string[]): string {
  return issues.map((i) => `<span class="badge bad">${escapeHtml(i)}</span>`).join(" ");
}

export function rateCell(rate: number): string {
  const tone = rateTone(rate);
  return `<div class="rate"><div class="rate-track"><div class="rate-fill ${tone}" style="width:${Math.max(0, Math.min(100, rate)).toFixed(1)}%"></div></div><span class="rate-num ${tone}">${fmtPct(rate)}</span></div>`;
}

export function emptyState(title: string, body: string): string {
  return `<div class="empty"><h3>${escapeHtml(title)}</h3><p>${body}</p></div>`;
}

// ---------- URL helpers ----------

/** The current URL with some query params set/removed. `page` is dropped by
 * default because changing any filter should return to the first page. */
export function urlWith(url: URL, set: Record<string, string | undefined>, drop: string[] = ["page"]): string {
  const p = new URLSearchParams(url.searchParams);
  p.delete("domain"); // legacy single-domain alias, normalised to `domains`
  for (const k of drop) p.delete(k);
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || v === "") p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  return qs ? `${url.pathname}?${qs}` : url.pathname;
}

/** Hidden form inputs that carry the global filters through a GET form. */
export function hiddenFilterInputs(f: Filters, extra: Record<string, string | undefined> = {}): string {
  const fields: Record<string, string | undefined> = { ...extra };
  if (f.domains.length) fields.domains = f.domains.join(",");
  if (f.expr) fields.f = encodeExpr(f.expr);
  if (f.range === null) fields.range = "all";
  else if (f.range !== DEFAULT_RANGE) fields.range = String(f.range);
  return Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v as string)}">`)
    .join("");
}

// ---------- table helpers ----------

export function sortTh(
  label: string,
  key: string,
  list: ListState,
  url: URL,
  opts: { num?: boolean; defaultDir?: "asc" | "desc"; anchor?: string } = {},
): string {
  const active = list.sort === key;
  const next = active ? (list.dir === "asc" ? "desc" : "asc") : (opts.defaultDir ?? (opts.num ? "desc" : "asc"));
  const href = urlWith(url, { sort: key, dir: next }) + (opts.anchor ? `#${opts.anchor}` : "");
  const aria = active ? (list.dir === "asc" ? "ascending" : "descending") : "none";
  return `<th class="${opts.num ? "num" : ""}" aria-sort="${aria}"><a href="${href}">${escapeHtml(label)}</a></th>`;
}

export function pagination(o: {
  page: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
  noun: string;
}): string {
  const pages = Math.max(1, Math.ceil(o.total / o.pageSize));
  const page = Math.min(o.page, pages);
  const from = o.total === 0 ? 0 : (page - 1) * o.pageSize + 1;
  const to = Math.min(o.total, page * o.pageSize);
  const summary = `Showing ${fmtNumber(from)}&ndash;${fmtNumber(to)} of ${fmtNumber(o.total)} ${o.noun}`;
  if (pages <= 1) return `<div class="pager"><span>${summary}</span></div>`;

  const nums = new Set([1, pages, page - 1, page, page + 1]);
  const list = [...nums].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items: string[] = [];
  let prev = 0;
  for (const n of list) {
    if (n - prev > 1) items.push('<span class="gap">&hellip;</span>');
    items.push(n === page ? `<span class="cur" aria-current="page">${n}</span>` : `<a href="${o.href(n)}">${n}</a>`);
    prev = n;
  }
  const prevLink = `<a class="${page <= 1 ? "off" : ""}" href="${o.href(Math.max(1, page - 1))}" aria-label="Previous page">&lsaquo;</a>`;
  const nextLink = `<a class="${page >= pages ? "off" : ""}" href="${o.href(Math.min(pages, page + 1))}" aria-label="Next page">&rsaquo;</a>`;
  return `<nav class="pager" aria-label="Pagination"><span>${summary}</span><div class="pages">${prevLink}${items.join("")}${nextLink}</div></nav>`;
}

export function searchForm(o: {
  action: string;
  filters: Filters;
  list: ListState;
  placeholder: string;
  extra?: Record<string, string | undefined>;
  anchor?: string;
}): string {
  const keep: Record<string, string | undefined> = { ...o.extra };
  if (o.list.sort) keep.sort = o.list.sort;
  keep.dir = o.list.dir;
  return `<form class="search" method="get" action="${o.action}${o.anchor ? "#" + o.anchor : ""}" role="search">
    ${hiddenFilterInputs(o.filters, keep)}
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input class="input" type="search" name="q" value="${escapeHtml(o.list.q)}" placeholder="${escapeHtml(o.placeholder)}" aria-label="${escapeHtml(o.placeholder)}">
  </form>`;
}

// ---------- shell ----------

/** The "Export" menu for a table. The links carry the page's current domain
 * filter, time range and search, so the file matches what is on screen. */
export function exportMenu(url: URL, items: Array<{ dataset: string; label: string }>): string {
  const keep = new URLSearchParams();
  for (const k of ["domains", "domain", "range", "q", "filter"]) {
    const v = url.searchParams.get(k);
    if (v) keep.set(k, v);
  }
  const href = (dataset: string, format: string) => {
    const p = new URLSearchParams(keep);
    p.set("format", format);
    return `/export/${dataset}?${p.toString()}`;
  };
  const rows = items
    .map(
      (i) =>
        `<div class="menu-item"><span>${escapeHtml(i.label)}</span><span class="menu-links"><a href="${href(i.dataset, "csv")}" download>CSV</a><a href="${href(i.dataset, "json")}" download>JSON</a></span></div>`,
    )
    .join("");
  return `<details class="menu"><summary class="btn secondary" aria-label="Export this table">${ICON.download}<span>Export</span></summary><div class="menu-list">${rows}<div class="menu-note">Asks for the admin login. Matches the filters and search shown.</div></div></details>`;
}

export interface Chrome {
  allDomains: string[];
  /** Tags in use, with how many domains carry each. */
  tags: Array<{ tag: string; count: number; byRule: number; color: string; chosen: boolean }>;
  lastSync: LastSync | null;
}

export type NavKey = "overview" | "domains" | "tags" | "reports" | "tls" | "map" | "report" | "admin";

export interface PageOpts {
  title: string;
  subtitle?: string;
  active: NavKey | null;
  url: URL;
  /** When present, the domain and time-range controls are shown. */
  filters?: Filters;
  chrome?: Chrome;
  body: string;
  charts?: boolean;
  leaflet?: boolean;
  scripts?: string;
  /** Page-specific CSS appended after the shared styles. */
  css?: string;
  /** Signed in with the login page (not just a script's credentials): shows Sign out. */
  signedIn?: boolean;
  /** Load the filter builder script (the filter bar loads it on its own). */
  filterBuilder?: boolean;
}

const ICON = {
  overview: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  domains: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  reports: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  tls: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  signout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  admin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  report: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6"/></svg>',
  sun: '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>',
  filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8.5V20l-4-2v-4.5z"/></svg>',
};

export const LOGO =
  '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs><path d="M50 4 L90 20 V48 C90 74 72 90 50 97 C28 90 10 74 10 48 V20 Z" fill="url(#lg)"/><path d="M32 50 L45 63 L70 36" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236366f1'/%3E%3Cstop offset='1' stop-color='%23a855f7'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M50 4 L90 20 V48 C90 74 72 90 50 97 C28 90 10 74 10 48 V20 Z' fill='url(%23g)'/%3E%3Cpath d='M32 50 L45 63 L70 36' stroke='white' stroke-width='9' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const NAV: Array<{ key: NavKey; href: string; label: string; icon: string }> = [
  { key: "overview", href: "/", label: "Overview", icon: ICON.overview },
  { key: "domains", href: "/domains", label: "Domains", icon: ICON.domains },
  { key: "tags", href: "/tags", label: "Tags", icon: ICON.tag },
  { key: "reports", href: "/reports", label: "DMARC reports", icon: ICON.reports },
  { key: "tls", href: "/tls-reports", label: "TLS reports", icon: ICON.tls },
  { key: "map", href: "/map", label: "Sender map", icon: ICON.map },
  { key: "report", href: "/report", label: "Summary report", icon: ICON.report },
];

// Dark is the default (set on <html>); a saved choice overrides it before first paint, so the page never flashes the wrong theme.
export const THEME_INIT = `try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}`;

const CHART_SETUP = `
function themeCharts(){
  var s=getComputedStyle(document.documentElement),c=function(n){return s.getPropertyValue(n).trim()};
  Chart.defaults.font.family="'Inter',-apple-system,'Segoe UI',sans-serif";
  Chart.defaults.font.size=12;
  Chart.defaults.color=c('--muted');
  Chart.defaults.borderColor=c('--border');
  Chart.defaults.plugins.tooltip.backgroundColor='rgba(12,14,30,0.95)';
  Chart.defaults.plugins.tooltip.padding=10;
  Chart.defaults.plugins.tooltip.cornerRadius=8;
  Chart.defaults.plugins.legend.labels.usePointStyle=true;
  Chart.defaults.plugins.legend.labels.boxWidth=8;
}
function mountCharts(fn){window.__mount=fn;themeCharts();fn()}`;

const SHELL_JS = `
(function(){
  var btn=document.getElementById('theme-btn');
  if(btn)btn.addEventListener('click',function(){
    var d=document.documentElement,next=d.dataset.theme==='dark'?'light':'dark';
    d.dataset.theme=next;try{localStorage.setItem('theme',next)}catch(e){}
    if(window.Chart&&window.__mount){Object.values(Chart.instances).forEach(function(c){c.destroy()});themeCharts();window.__mount()}
  });
  document.addEventListener('click',function(e){
    var row=e.target.closest&&e.target.closest('tr[data-href]');
    if(row&&!e.target.closest('a,button,input,select,summary'))location.href=row.getAttribute('data-href');
  });
  document.addEventListener('click',function(e){document.querySelectorAll('details.menu[open]').forEach(function(d){if(!d.contains(e.target))d.removeAttribute('open')})});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('details.menu[open]').forEach(function(d){d.removeAttribute('open')})});
})();`;

const DOMAIN_FILTER_JS = `
(function(){
  var data=JSON.parse(document.getElementById('dms-data').textContent);
  var all=data.all,sel=new Set(data.selected),LIMIT=100,MAXSEL=200;
  var trigger=document.getElementById('dms-trigger'),panel=document.getElementById('dms-panel'),
      search=document.getElementById('dms-search'),list=document.getElementById('dms-list'),
      chips=document.getElementById('dms-chips'),hint=document.getElementById('dms-hint');
  function close(){panel.hidden=true;trigger.setAttribute('aria-expanded','false')}
  function open(){panel.hidden=false;trigger.setAttribute('aria-expanded','true');search.focus()}
  function render(){
    var q=search.value.trim().toLowerCase();
    var m=q?all.filter(function(d){return d.toLowerCase().indexOf(q)>-1}):all;
    var shown=m.slice(0,LIMIT);
    list.textContent='';
    shown.forEach(function(d){
      var l=document.createElement('label');l.className='dms-item';
      var c=document.createElement('input');c.type='checkbox';c.checked=sel.has(d);
      c.addEventListener('change',function(){
        if(c.checked){if(sel.size>=MAXSEL){c.checked=false;hint.textContent='You can select up to '+MAXSEL+' domains.';return}sel.add(d)}else sel.delete(d);
        renderChips();
      });
      var s=document.createElement('span');s.textContent=d;l.appendChild(c);l.appendChild(s);list.appendChild(l);
    });
    if(!shown.length){var e=document.createElement('div');e.className='dms-empty';e.textContent='No matching domains';list.appendChild(e)}
    hint.textContent=m.length>LIMIT?'Showing the first '+LIMIT+' of '+m.length+' matches. Keep typing to narrow.':all.length+' domains';
    renderChips();
  }
  function renderChips(){
    chips.textContent='';
    var arr=Array.from(sel);
    arr.slice(0,12).forEach(function(d){
      var b=document.createElement('button');b.type='button';b.className='dms-chip';b.textContent=d+' \\u00d7';
      b.setAttribute('aria-label','Remove '+d);
      b.addEventListener('click',function(){sel.delete(d);render()});chips.appendChild(b);
    });
    if(arr.length>12){var s=document.createElement('span');s.className='dms-hint';s.textContent='+'+(arr.length-12)+' more';chips.appendChild(s)}
  }
  trigger.addEventListener('click',function(e){e.stopPropagation();panel.hidden?open():close()});
  panel.addEventListener('click',function(e){e.stopPropagation()});
  document.addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){close();trigger.focus()}});
  search.addEventListener('input',render);
  document.getElementById('dms-clear').addEventListener('click',function(){sel.clear();render()});
  document.getElementById('dms-apply').addEventListener('click',function(){
    var u=new URL(location.href);u.searchParams.delete('domain');u.searchParams.delete('page');
    if(sel.size)u.searchParams.set('domains',Array.from(sel).join(','));else u.searchParams.delete('domains');
    location.href=u.pathname+u.search;
  });
  render();
})();`;

function domainFilterHtml(allDomains: string[], selected: string[]): string {
  const label =
    selected.length === 0
      ? `All domains <span class="muted">(${fmtNumber(allDomains.length)})</span>`
      : selected.length === 1
        ? escapeHtml(selected[0])
        : `${selected.length} domains`;
  return `<div class="dms">
    <button type="button" class="dms-trigger" id="dms-trigger" aria-haspopup="true" aria-expanded="false" aria-controls="dms-panel">
      ${ICON.globe}<span class="label">${label}</span>${ICON.chevron}
    </button>
    <div class="dms-panel" id="dms-panel" hidden>
      <div class="dms-chips" id="dms-chips"></div>
      <input class="input" id="dms-search" type="search" placeholder="Search ${fmtNumber(allDomains.length)} domains" aria-label="Search domains" autocomplete="off">
      <div class="dms-list" id="dms-list"></div>
      <div class="dms-hint" id="dms-hint" aria-live="polite"></div>
      <div class="dms-foot"><button type="button" class="link-btn" id="dms-clear">Clear selection</button><button type="button" class="btn" id="dms-apply">Apply</button></div>
    </div>
    <script type="application/json" id="dms-data">${safeJson({ all: allDomains, selected })}</script>
  </div>`;
}

function filterBarHtml(f: Filters, chrome: Chrome): string {
  const n = f.expr ? countConditions(f.expr) : 0;
  return `<div class="dms">
    <button type="button" class="dms-trigger" id="fb-trigger" aria-haspopup="true" aria-expanded="false" aria-controls="fb-panel">
      ${ICON.filter}<span class="label">Filter</span>${n ? `<span class="fb-count">${n}</span>` : ""}${ICON.chevron}
    </button>
    <div class="dms-panel fb-panel" id="fb-panel" hidden>
      <div id="fb-root"></div>
      <div class="fb-err" id="fb-msg" role="alert"></div>
      <div class="dms-foot"><button type="button" class="link-btn" id="fb-clear">Clear filter</button><button type="button" class="btn" id="fb-apply">Apply</button></div>
    </div>
    <script type="application/json" id="fb-data">${safeJson({ ops: FILTER_OPS, tags: chrome.tags, expr: f.expr ? toWire(f.expr) : null })}</script>
  </div>`;
}

function freshness(lastSync: LastSync | null): string {
  if (!lastSync) return `<span class="fresh" title="No sync has run yet"><i class="dot none"></i>Not synced yet</span>`;
  const age = Math.floor(Date.now() / 1000) - lastSync.at;
  const stale = !lastSync.ok || age > 3600;
  const label = lastSync.ok ? `Synced ${relTime(lastSync.at)}` : `Last sync failed ${relTime(lastSync.at)}`;
  return `<span class="fresh" title="${escapeHtml(lastSync.summary)}"><i class="dot ${stale ? "stale" : ""}"></i>${label}</span>`;
}

export function layout(o: PageOpts): string {
  const f = o.filters ?? null;
  const link = (path: string) => (f ? withFilters(path, f) : path);

  const nav = NAV.map(
    (n) =>
      `<a href="${link(n.href)}"${n.key === o.active ? ' aria-current="page"' : ""}>${n.icon}<span>${n.label}</span></a>`,
  ).join("");

  const ranges = f
    ? `<div class="seg" role="group" aria-label="Time range">${[...RANGE_OPTIONS, "all" as const]
        .map((r) => {
          const val = r === "all" ? null : r;
          const current = f.range === val;
          const set = r === "all" ? "all" : r === DEFAULT_RANGE ? undefined : String(r);
          const label = r === "all" ? "All" : r === 365 ? "1y" : `${r}d`;
          return `<a href="${urlWith(o.url, { range: set })}" aria-current="${current}">${label}</a>`;
        })
        .join("")}</div>`
    : "";

  const domainCtl = f && o.chrome ? domainFilterHtml(o.chrome.allDomains, f.domains) : "";

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)} · ${BRAND}</title>
<link rel="icon" href="${FAVICON}">
<script>${THEME_INIT}</script>
<link rel="preload" href="/vendor/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
${o.charts ? `<script src="/vendor/chart.min.js"></script>\n<script>${CHART_SETUP}</script>` : ""}
${o.leaflet ? `<meta name="referrer" content="origin">
<link rel="stylesheet" href="/vendor/leaflet.css">\n<script src="/vendor/leaflet.js"></script>` : ""}
<style>${STYLES}${FILTER_BUILDER_CSS}${o.css ?? ""}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="${link("/")}">${LOGO}<span>${BRAND}</span></a>
    <nav class="nav" aria-label="Primary">${nav}</nav>
    <div class="side-foot">
      <a class="side-link" href="/admin"${o.active === "admin" ? ' aria-current="page"' : ""}>${ICON.admin}<span>Admin</span></a>
      <button class="theme-btn" id="theme-btn" type="button" aria-label="Toggle dark mode">${ICON.sun}${ICON.moon}<span>Theme</span></button>
      ${o.signedIn ? `<form method="post" action="/logout" class="signout"><button class="theme-btn" type="submit">${ICON.signout}<span>Sign out</span></button></form>` : ""}
    </div>
  </aside>
  <div class="main-col">
    <header class="topbar">
      <div class="titles">
        <h1>${escapeHtml(o.title)}</h1>
        ${o.subtitle ? `<div class="sub">${o.subtitle}</div>` : ""}
      </div>
      <div class="filters">${o.chrome ? freshness(o.chrome.lastSync) : ""}${f && o.chrome ? filterBarHtml(f, o.chrome) : ""}${domainCtl}${ranges}</div>
    </header>
    <main id="main" tabindex="-1">
${o.body}
    </main>
  </div>
</div>
<script>${SHELL_JS}</script>
${f && o.chrome ? `<script>${DOMAIN_FILTER_JS}</script>` : ""}
${(f && o.chrome) || o.filterBuilder ? `<script>${FILTER_BUILDER_JS}</script>` : ""}
${f && o.chrome ? `<script>${FILTER_BAR_JS}</script>` : ""}
${o.scripts ? `<script>${o.scripts}</script>` : ""}
</body>
</html>`;
}

export function panel(title: string, body: string, opts: { sub?: string; actions?: string; flush?: boolean; id?: string } = {}): string {
  return `<section class="panel"${opts.id ? ` id="${opts.id}"` : ""}>
  <div class="panel-head"><div><h2 class="panel-title">${escapeHtml(title)}</h2>${opts.sub ? `<div class="panel-sub">${opts.sub}</div>` : ""}</div>${opts.actions ?? ""}</div>
  <div class="panel-body${opts.flush ? " flush" : ""}">${body}</div>
</section>`;
}
