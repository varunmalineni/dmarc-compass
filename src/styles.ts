// Design tokens + component styles. Light and dark themes share one set of
// semantic variables; components only ever reference the variables.

export const STYLES = `
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(/vendor/inter-latin-wght-normal.woff2) format('woff2'); }
:root {
  color-scheme: light;
  --bg: #f4f5f9;
  --surface: #ffffff;
  --surface-2: #f8f9fc;
  --border: #e4e6ef;
  --border-strong: #d2d6e4;
  --text: #0f1222;
  --text-2: #454b63;
  --muted: #6a7188;
  --accent: #4f46e5;
  --accent-2: #7c3aed;
  --accent-soft: #eef0ff;
  --accent-text: #3730a3;
  --good: #15803d;
  --good-soft: #e7f7ed;
  --good-bar: #22c55e;
  --warn: #b45309;
  --warn-soft: #fff3d6;
  --warn-bar: #f59e0b;
  --bad: #b91c1c;
  --bad-soft: #fdeaea;
  --bad-bar: #ef4444;
  --sidebar: #0e1124;
  --sidebar-text: rgba(255,255,255,0.66);
  --shadow-sm: 0 1px 2px rgba(15,18,34,0.05), 0 1px 3px rgba(15,18,34,0.06);
  --shadow-md: 0 12px 32px rgba(15,18,34,0.14);
  --radius: 12px;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0a0c18;
  --surface: #12152a;
  --surface-2: #171b34;
  --border: #242946;
  --border-strong: #323959;
  --text: #e9ebf7;
  --text-2: #b6bbd6;
  --muted: #8a90ad;
  --accent: #818cf8;
  --accent-2: #a78bfa;
  --accent-soft: rgba(129,140,248,0.15);
  --accent-text: #c7d2fe;
  --good: #4ade80;
  --good-soft: rgba(74,222,128,0.12);
  --warn: #fbbf24;
  --warn-soft: rgba(251,191,36,0.13);
  --bad: #f87171;
  --bad-soft: rgba(248,113,113,0.13);
  --sidebar: #070914;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
  --shadow-md: 0 14px 36px rgba(0,0,0,0.55);
}

* { box-sizing: border-box; }
html { scrollbar-gutter: stable; }
body {
  margin: 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.skip {
  position: absolute; left: -9999px; top: 8px; background: var(--accent); color: #fff;
  padding: 8px 14px; border-radius: 8px; z-index: 100; text-decoration: none; font-weight: 600;
}
.skip:focus { left: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---------- shell ---------- */
.shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; }
.sidebar {
  position: sticky; top: 0; height: 100vh; background: var(--sidebar); color: var(--sidebar-text);
  display: flex; flex-direction: column; padding: 18px 12px; gap: 4px;
}
.brand {
  display: flex; align-items: center; gap: 10px; padding: 4px 10px 20px;
  color: #fff; font-weight: 700; font-size: 15.5px; letter-spacing: -0.01em; text-decoration: none;
}
.brand svg { width: 26px; height: 26px; flex: none; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav a, .side-link, .theme-btn {
  display: flex; align-items: center; gap: 11px; padding: 9px 10px; border-radius: 9px;
  color: var(--sidebar-text); text-decoration: none; font-size: 13.5px; font-weight: 550;
  background: none; border: none; cursor: pointer; font-family: inherit; width: 100%; text-align: left;
  transition: background 0.12s ease, color 0.12s ease;
}
.nav a:hover, .side-link:hover, .theme-btn:hover { background: rgba(255,255,255,0.07); color: #fff; }
.nav a[aria-current="page"], .side-link[aria-current="page"] { background: rgba(255,255,255,0.1); color: #fff; box-shadow: inset 2px 0 0 #a5b4fc; }
.nav svg, .side-link svg, .theme-btn svg { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.signout { margin: 0; }
.signout .theme-btn { width: 100%; }
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 2px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px; }
.theme-btn .moon { display: none; }
:root[data-theme="dark"] .theme-btn .sun { display: none; }
:root[data-theme="dark"] .theme-btn .moon { display: block; }

.main-col { min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 30; display: flex; align-items: center; justify-content: space-between;
  gap: 16px 24px; flex-wrap: wrap; padding: 14px 32px;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  -webkit-backdrop-filter: saturate(1.5) blur(12px); backdrop-filter: saturate(1.5) blur(12px);
  border-bottom: 1px solid var(--border);
}
.titles h1 { margin: 0; font-size: 21px; font-weight: 700; letter-spacing: -0.015em; line-height: 1.25; }
.titles .sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.fresh { font-size: 12px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good-bar); display: inline-block; }
.dot.stale { background: var(--warn-bar); }
.dot.none { background: var(--border-strong); }
main { width: 100%; max-width: 1380px; margin: 0 auto; padding: 24px 32px 56px; }

/* ---------- surfaces ---------- */
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); margin-bottom: 20px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 15px 20px; border-bottom: 1px solid var(--border); }
.panel-title { margin: 0; font-size: 14.5px; font-weight: 650; letter-spacing: -0.005em; }
.panel-sub { font-size: 12.5px; color: var(--muted); margin-top: 1px; }
.panel-body { padding: 18px 20px; }
.panel-body.flush { padding: 0; }
.grid-main { display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(300px, 1fr); gap: 20px; align-items: start; }
.grid-main > .panel, .stack > .panel { margin-bottom: 20px; }
.stack { min-width: 0; }
.chart-box { position: relative; height: 280px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 14px; margin-bottom: 20px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow-sm); }
.kpi-label { font-size: 11.5px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.kpi-value { font-size: 28px; font-weight: 750; letter-spacing: -0.02em; margin-top: 6px; font-variant-numeric: tabular-nums; line-height: 1.15; }
.kpi-foot { flex-wrap: wrap; margin-top: 7px; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; min-height: 20px; }
.delta { white-space: nowrap; font-weight: 650; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.delta.up { background: var(--good-soft); color: var(--good); }
.delta.down { background: var(--bad-soft); color: var(--bad); }
.delta.flat { background: var(--accent-soft); color: var(--accent-text); }
.v-good { color: var(--good); } .v-warn { color: var(--warn); } .v-bad { color: var(--bad); }

/* ---------- controls ---------- */
.seg { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 2px; box-shadow: var(--shadow-sm); }
.seg a { padding: 6px 11px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); text-decoration: none; }
.seg a:hover { color: var(--text); }
.seg a[aria-current="true"] { background: var(--accent); color: #fff; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  font-size: 12.5px; font-weight: 600; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border);
  color: var(--text-2); text-decoration: none; background: var(--surface); transition: border-color 0.12s, color 0.12s;
}
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip[aria-current="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-text); }
[hidden] { display: none !important; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: none; cursor: pointer;
  background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; font-family: inherit;
  padding: 9px 18px; border-radius: 9px; font-size: 13.5px; font-weight: 650; box-shadow: 0 4px 12px rgba(79,70,229,0.28);
  text-decoration: none;
}
.btn.secondary { background: var(--surface); color: var(--accent-text); border: 1px solid var(--border-strong); box-shadow: none; }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.input {
  width: 100%; padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface);
  color: var(--text); font-family: inherit; font-size: 13.5px;
}
/* One look for every dropdown: the arrow is drawn here, with room for it, instead of the browser's own. */
select, select.input {
  -webkit-appearance: none; appearance: none; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239096ad' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; background-size: 14px;
  padding-right: 32px;
}
select:disabled, select.input:disabled { cursor: not-allowed; opacity: 0.6; }
.input::placeholder { color: var(--muted); }
.input:disabled { background: var(--surface-2); cursor: not-allowed; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; padding: 14px 20px; border-bottom: 1px solid var(--border); }
.search { position: relative; min-width: 240px; flex: 0 1 320px; }
.search input { padding-left: 34px; }
.search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; stroke: var(--muted); fill: none; stroke-width: 2; stroke-linecap: round; pointer-events: none; }

/* domain multiselect */
.dms { position: relative; }
.dms-trigger {
  display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface); color: var(--text); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: var(--shadow-sm); max-width: 280px;
}
.dms-trigger:hover { border-color: var(--accent); }
.dms-trigger span.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-trigger svg { width: 14px; height: 14px; stroke: var(--muted); fill: none; stroke-width: 2; flex: none; }
.dms-panel {
  position: absolute; top: calc(100% + 8px); left: 0; z-index: 40; width: 340px; padding: 12px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-md);
}
.dms-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; max-height: 84px; overflow: auto; }
.dms-chip { background: var(--accent-soft); color: var(--accent-text); border: none; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
.dms-list { max-height: 250px; overflow-y: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin: 8px 0; padding: 4px 0; }
.dms-item { display: flex; align-items: center; gap: 9px; padding: 6px 6px; border-radius: 7px; cursor: pointer; font-size: 13.5px; }
.dms-item:hover { background: var(--surface-2); }
.dms-item input { accent-color: var(--accent); margin: 0; }
.dms-empty, .dms-hint { color: var(--muted); font-size: 12px; padding: 8px 6px; }
.dms-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dms-foot .btn { padding: 7px 16px; }
.link-btn { background: none; border: none; color: var(--accent); font-weight: 600; font-size: 12.5px; cursor: pointer; font-family: inherit; padding: 4px; }

/* ---------- tables ---------- */
.head-tools { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; }
.head-tools .search { min-width: 170px; flex: 0 1 300px; }
details.menu > summary { white-space: nowrap; }
details.menu { position: relative; }
details.menu > summary { list-style: none; padding: 7px 12px; font-size: 13px; }
details.menu > summary::-webkit-details-marker { display: none; }
details.menu > summary svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.menu-list { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; min-width: 280px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; box-shadow: var(--shadow-lg, 0 12px 32px rgba(0,0,0,.35)); padding: 6px; }
.menu-item { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 8px 10px; border-radius: 7px; font-size: 13px; }
.menu-item:hover { background: var(--surface-2); }
.menu-links { display: flex; gap: 6px; }
.menu-links a { font-weight: 650; font-size: 12px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--border-strong); color: var(--accent-text); text-decoration: none; }
.menu-links a:hover { background: var(--accent-soft); }
.menu-note { padding: 8px 10px 4px; font-size: 11.5px; color: var(--muted); border-top: 1px solid var(--border); margin-top: 4px; }
.table-wrap { overflow-x: auto; }
.table-wrap.scroll { max-height: 560px; overflow: auto; }
table.data { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13.5px; }
.data th {
  position: sticky; top: 0; z-index: 1; text-align: left; font-size: 11.5px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--muted); background: var(--surface-2); padding: 10px 11px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.data th a { color: inherit; text-decoration: none; }
.data th[data-sort], .data th.sortable { cursor: pointer; user-select: none; }
.data th[data-sort]:hover, .data th.sortable:hover { color: var(--text); }
.data th[aria-sort="ascending"]::after { content: " \\25B2"; font-size: 9px; }
.data th[aria-sort="descending"]::after { content: " \\25BC"; font-size: 9px; }
.data td.small { white-space: nowrap; }
.data td { padding: 11px 11px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.data tbody tr:last-child td { border-bottom: none; }
.data tbody tr:hover { background: var(--surface-2); }
.data tr.clickable { cursor: pointer; }
.data tr.clickable:hover { background: var(--accent-soft); }
.data .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.data th.num { text-align: right; }
.data .muted, .muted { color: var(--muted); }
.data .small { font-size: 12.5px; }
code { font-family: 'SF Mono', ui-monospace, Menlo, Consolas, monospace; font-size: 12px; background: var(--surface-2); border: 1px solid var(--border); padding: 1px 6px; border-radius: 6px; }
.esp { font-weight: 600; }
.ptr { font-size: 11.5px; color: var(--muted); margin-top: 1px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rate { display: flex; align-items: center; gap: 8px; min-width: 112px; }
.rate-track { flex: 1; height: 6px; background: var(--border); border-radius: 4px; overflow: hidden; }
.rate-fill { height: 100%; border-radius: 4px; }
.rate-fill.good { background: var(--good-bar); } .rate-fill.warn { background: var(--warn-bar); } .rate-fill.bad { background: var(--bad-bar); }
.rate-num { font-weight: 700; font-size: 12.5px; width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
.rate-num.good { color: var(--good); } .rate-num.warn { color: var(--warn); } .rate-num.bad { color: var(--bad); }
.tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.tag { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 1px 9px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); text-decoration: none; white-space: nowrap; border: 1px solid transparent; }
a.tag:hover { border-color: var(--accent); }
.head-tools .btn { white-space: nowrap; }
/* tag colours: data-c names a colour; the same rule works on both themes */
[data-c=red] { --tc: #ef4444; } [data-c=orange] { --tc: #f97316; } [data-c=amber] { --tc: #eab308; } [data-c=green] { --tc: #22c55e; } [data-c=teal] { --tc: #14b8a6; }
[data-c=blue] { --tc: #3b82f6; } [data-c=indigo] { --tc: #6366f1; } [data-c=purple] { --tc: #a855f7; } [data-c=pink] { --tc: #ec4899; } [data-c=gray] { --tc: #94a3b8; }
.tag[data-c], .te-chip[data-c] { background: color-mix(in srgb, var(--tc) 20%, var(--surface)); color: color-mix(in srgb, var(--tc) 78%, var(--text)); border-color: color-mix(in srgb, var(--tc) 38%, transparent); }
a.tag[data-c]:hover { border-color: var(--tc); }
.swatch { width: 18px; height: 18px; flex: none; border-radius: 50%; border: 2px solid transparent; background: var(--tc, var(--muted)); cursor: pointer; padding: 0; box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent); }
.swatch:hover { transform: scale(1.12); }
.swatch[aria-pressed=true] { border-color: var(--surface); box-shadow: 0 0 0 2px var(--text); }
.tag-edit { font-family: inherit; font-size: 11.5px; font-weight: 600; padding: 1px 9px; border-radius: 999px; background: none; color: var(--muted); border: 1px dashed var(--border-strong); cursor: pointer; line-height: 1.5; }
.tag-edit:hover { color: var(--accent-text); border-color: var(--accent); background: var(--accent-soft); }
.te-pop { position: absolute; z-index: 60; width: 290px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-md); }
.te-pop .te-title { font-weight: 650; font-size: 13px; margin-bottom: 8px; word-break: break-all; }
.te-pop .te-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; min-height: 22px; }
.te-pop .te-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600; padding: 1px 4px 1px 9px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); }
.te-pop .te-chip button { border: none; background: none; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 3px; opacity: 0.7; }
.te-pop .te-chip button:hover { opacity: 1; color: var(--bad); }
.te-pop .te-row { display: flex; gap: 6px; }
.te-pop .te-row input { flex: 1; min-width: 0; height: 32px; box-sizing: border-box; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text); font-family: inherit; font-size: 13px; }
.te-pop .te-row .btn { height: 32px; padding: 0 14px; }
.te-pop .te-err { color: var(--bad); font-size: 12px; margin-top: 6px; min-height: 0; }
.tag.more { background: var(--surface-2); color: var(--muted); }
.tag.auto::after { content: "\\2699\\FE0E"; margin-left: 4px; font-size: 10px; opacity: 0.75; }
.badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; margin: 1px 2px 1px 0; letter-spacing: 0.01em; white-space: nowrap; }
.badge.bad { background: var(--bad-soft); color: var(--bad); }
.badge.good { background: var(--good-soft); color: var(--good); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.neutral { background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border); }
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 20px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--muted); }
.pager .pages { display: flex; gap: 4px; }
.pager a, .pager span.cur { min-width: 32px; padding: 5px 9px; border-radius: 8px; text-align: center; text-decoration: none; font-weight: 600; border: 1px solid var(--border); color: var(--text-2); background: var(--surface); }
.pager a:hover { border-color: var(--accent); color: var(--accent); }
.pager span.cur { background: var(--accent); border-color: var(--accent); color: #fff; }
.pager span.gap { padding: 5px 4px; border: none; background: none; }
.pager .off { opacity: 0.4; pointer-events: none; }

/* ---------- messages ---------- */
.empty { text-align: center; padding: 44px 24px; color: var(--muted); }
.empty h3 { margin: 0 0 6px; color: var(--text); font-size: 15px; }
.empty p { margin: 0 auto; max-width: 460px; font-size: 13px; }
.callout { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 20px; background: var(--accent-soft); }
.callout h3 { margin: 0 0 4px; font-size: 14.5px; color: var(--accent-text); }
.callout p { margin: 0; font-size: 13px; color: var(--text-2); }
.warn-box { background: var(--warn-soft); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); color: var(--text); border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 16px; }
.hint { font-size: 12.5px; color: var(--muted); line-height: 1.55; }
.verdict { display: flex; gap: 14px; padding: 14px 16px; border-radius: 10px; margin-bottom: 14px; }
.verdict.good { background: var(--good-soft); } .verdict.bad { background: var(--bad-soft); } .verdict.warn { background: var(--warn-soft); }
.verdict-icon { width: 26px; height: 26px; flex: none; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; }
.verdict.good .verdict-icon { background: var(--good-bar); } .verdict.bad .verdict-icon { background: var(--bad-bar); } .verdict.warn .verdict-icon { background: var(--warn-bar); }
.verdict-title { font-weight: 650; margin-bottom: 2px; }
.verdict-body { font-size: 13px; color: var(--text-2); line-height: 1.55; }
.note { font-size: 12.5px; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px; line-height: 1.55; margin-bottom: 14px; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.list li:last-child { border-bottom: none; }
.list-title { font-size: 11.5px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); margin: 14px 0 2px; }
.dist { display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: var(--border); margin: 8px 0 10px; }
.dist span { display: block; height: 100%; }
.dist-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--text-2); }
.dist-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 6px; }
.kv { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.kv td { padding: 10px 0; border-bottom: 1px solid var(--border); }
.kv tr:last-child td { border-bottom: none; }
.kv td:first-child { color: var(--muted); font-weight: 600; width: 190px; }
.raw-status { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 9px 12px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); font-size: 13px; color: var(--text-2); }
.raw-status.done { color: var(--good); } .raw-status.error { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--border)); }
.spinner { width: 15px; height: 15px; flex: none; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.raw-dialog { width: min(980px, 94vw); max-height: 86vh; padding: 0; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: 0 24px 60px rgba(0,0,0,.45); }
.raw-dialog::backdrop { background: rgba(5, 8, 20, 0.6); }
.raw-dialog-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.raw-dialog-head .grow { flex: 1; }
.raw-dialog-head .btn { padding: 5px 11px; font-size: 12.5px; }
.raw-dialog pre { margin: 0; padding: 14px 16px; max-height: calc(86vh - 60px); overflow: auto; font: 12.5px/1.55 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
.raw-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
.raw-links .btn { padding: 6px 12px; font-size: 12.5px; text-decoration: none; }
.back { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); text-decoration: none; font-weight: 600; font-size: 13px; margin-bottom: 14px; }
.foot { text-align: center; color: var(--muted); font-size: 12px; margin-top: 8px; }

/* ---------- responsive ---------- */
@media (max-width: 1100px) { .grid-main { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 860px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: static; height: auto; flex-direction: row; align-items: center; padding: 10px 12px; overflow-x: auto; gap: 4px; }
  .brand { padding: 4px 10px; }
  .brand span { display: none; }
  .nav { flex-direction: row; }
  .nav a { white-space: nowrap; }
  .side-foot { margin: 0 0 0 auto; border: none; padding: 0; flex-direction: row; }
  .side-link span, .theme-btn span { display: none; }
  .topbar { padding: 12px 16px; position: static; }
  main { padding: 16px 16px 40px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } .spinner { animation-duration: 3s; } }
@media print {
  .sidebar, .filters, .toolbar, .pager, .skip { display: none !important; }
  .shell { display: block; } .topbar { position: static; border: none; padding: 0 0 12px; }
  body { background: #fff; } .panel, .kpi { box-shadow: none; break-inside: avoid; }
}
/* leaflet: keep its high z-index panes from covering the dropdowns */
#map { position: relative; z-index: 0; isolation: isolate; height: 520px; border-radius: 10px; }
.leaflet-container { background: var(--surface-2); }
:root[data-theme="dark"] .leaflet-tile { filter: invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.88); }
`;
