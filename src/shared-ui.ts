// Shared formatting/escaping helpers, the top nav and the page styles used
// by every dashboard page.

export const BRAND = "dmarc-compass";

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
  });
}

export function fmtNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function passRateBadgeClass(rate: number): string {
  if (rate >= 99.9) return "badge-good";
  if (rate >= 90) return "badge-warn";
  return "badge-bad";
}

/** Mirrors the "Issue" tags from the original dmarc-report-viewer's
 * /sources endpoint: policy-level (aligned) vs. raw auth-level failures,
 * tracked separately since they point to different root causes. */
export function deriveIssues(r: {
  policy_dkim?: string | null;
  policy_spf?: string | null;
  auth_dkim_result?: string | null;
  auth_spf_result?: string | null;
}): string[] {
  const issues: string[] = [];
  if (r.policy_dkim && r.policy_dkim !== "pass") issues.push("DKIM Policy");
  if (r.policy_spf && r.policy_spf !== "pass") issues.push("SPF Policy");
  if (r.auth_dkim_result && r.auth_dkim_result !== "pass") issues.push("DKIM Auth");
  if (r.auth_spf_result && r.auth_spf_result !== "pass") issues.push("SPF Auth");
  return issues;
}

export function issueBadgesHtml(issues: string[]): string {
  if (issues.length === 0) return "";
  return issues.map((i) => `<span class="issue-badge">${escapeHtml(i)}</span>`).join(" ");
}

export function navHtml(
  active: "overview" | "reports" | "domains" | "tls" | "map" | null,
  domain: string | null,
): string {
  const q = domain ? `?domain=${encodeURIComponent(domain)}` : "";
  return `
    <nav class="top-nav">
      <a href="/${q}" class="${active === "overview" ? "active" : ""}">Overview</a>
      <a href="/domains" class="${active === "domains" ? "active" : ""}">Domains</a>
      <a href="/reports${q}" class="${active === "reports" ? "active" : ""}">DMARC Reports</a>
      <a href="/tls-reports${q}" class="${active === "tls" ? "active" : ""}">TLS Reports</a>
      <a href="/map${q}" class="${active === "map" ? "active" : ""}">Sender Map</a>
      <a href="/classic/" class="external">Classic dashboard &#8599;</a>
    </nav>`;
}

export function domainSelectorHtml(domains: string[], current: string | null, basePath: string): string {
  if (domains.length <= 1) return "";
  const options = [
    `<option value="" ${!current ? "selected" : ""}>All Domains (${domains.length})</option>`,
    ...domains.map((d) => `<option value="${escapeHtml(d)}" ${d === current ? "selected" : ""}>${escapeHtml(d)}</option>`),
  ].join("");
  return `
    <div class="domain-selector">
      <label for="domain-select">Domain:</label>
      <select id="domain-select" onchange="
        const v = this.value;
        location.href = '${basePath}' + (v ? '?domain=' + encodeURIComponent(v) : '');
      ">${options}</select>
    </div>`;
}

/** Multi-select domain filter: all / one / a handful. Includes a search
 * box since production will have 1,500+ domains - a plain dropdown or
 * checkbox wall doesn't scale, but filtering a list of plain strings
 * client-side at that count is still instant. */
export function domainMultiSelectHtml(domains: string[], selected: string[], basePath: string): string {
  const summary =
    selected.length === 0
      ? `All Domains (${domains.length})`
      : selected.length === 1
        ? selected[0]
        : `${selected.length} Domains Selected`;

  const items = domains
    .map(
      (d) =>
        `<label class="dms-item"><input type="checkbox" value="${escapeHtml(d)}" ${selected.includes(d) ? "checked" : ""}/> <span>${escapeHtml(d)}</span></label>`,
    )
    .join("");

  return `
    <div class="domain-multiselect">
      <button type="button" class="dms-trigger" id="dms-trigger">${escapeHtml(summary)} <span class="dms-caret">&#9662;</span></button>
      <div class="dms-panel" id="dms-panel" hidden>
        <input type="text" class="dms-search" id="dms-search" placeholder="Search ${domains.length} domains..." />
        <div class="dms-actions">
          <button type="button" id="dms-select-all">Select all visible</button>
          <button type="button" id="dms-clear">Clear</button>
        </div>
        <div class="dms-list" id="dms-list">${items}</div>
        <button type="button" class="dms-apply" id="dms-apply">Apply</button>
      </div>
    </div>
    <script>
      (function () {
        const trigger = document.getElementById('dms-trigger');
        const panel = document.getElementById('dms-panel');
        const search = document.getElementById('dms-search');
        const list = document.getElementById('dms-list');
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          panel.hidden = !panel.hidden;
          if (!panel.hidden) search.focus();
        });
        panel.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => { panel.hidden = true; });
        search.addEventListener('input', () => {
          const q = search.value.toLowerCase();
          list.querySelectorAll('.dms-item').forEach((item) => {
            item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
          });
        });
        document.getElementById('dms-select-all').addEventListener('click', () => {
          list.querySelectorAll('.dms-item').forEach((item) => {
            if (item.style.display !== 'none') item.querySelector('input').checked = true;
          });
        });
        document.getElementById('dms-clear').addEventListener('click', () => {
          list.querySelectorAll('input').forEach((cb) => { cb.checked = false; });
        });
        document.getElementById('dms-apply').addEventListener('click', () => {
          const checked = [...list.querySelectorAll('input:checked')].map((cb) => cb.value);
          const url = new URL(window.location.href);
          url.searchParams.delete('domain');
          if (checked.length === 0) {
            url.searchParams.delete('domains');
          } else {
            url.searchParams.set('domains', checked.join(','));
          }
          window.location.href = '${basePath}' + (url.search || '');
        });
      })();
    </script>`;
}

export const SHARED_STYLES = `
  :root {
    --bg: #f5f6fb;
    --card: #ffffff;
    --border: #e7e8f1;
    --text: #0f1222;
    --muted: #6b7280;
    --accent: #4338ca;
    --accent-2: #6d28d9;
    --accent-light: #eef0ff;
    --good: #15803d;
    --good-bg: #ecfdf3;
    --warn: #b45309;
    --warn-bg: #fffaeb;
    --bad: #b91c1c;
    --bad-bg: #fef2f2;
    --shadow-sm: 0 1px 2px rgba(15, 18, 34, 0.04), 0 1px 3px rgba(15, 18, 34, 0.05);
    --shadow-md: 0 8px 24px rgba(15, 18, 34, 0.08);
  }
  * { box-sizing: border-box; }
  html { scrollbar-gutter: stable; }
  body {
    margin: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  header {
    background:
      radial-gradient(1200px 320px at 15% -20%, rgba(255,255,255,0.14), transparent 60%),
      linear-gradient(120deg, #2b2470, #4338ca 55%, #5b21b6);
    color: white;
    padding: 30px 40px 0;
    box-shadow: 0 1px 0 rgba(0,0,0,0.06);
  }
  header .eyebrow {
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  header h1 {
    margin: 5px 0 0;
    font-size: 27px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .top-nav {
    display: flex;
    gap: 24px;
    margin-top: 24px;
    padding-top: 2px;
    border-top: 1px solid rgba(255,255,255,0.14);
    flex-wrap: wrap;
  }
  .top-nav a {
    color: rgba(255,255,255,0.62);
    text-decoration: none;
    font-size: 13.5px;
    font-weight: 600;
    padding: 13px 1px;
    border-bottom: 2px solid transparent;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  .top-nav a.active { color: white; border-bottom-color: #a5b4fc; }
  .top-nav a.external { margin-left: auto; color: rgba(255,255,255,0.48); }
  .top-nav a:hover { color: white; }
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 32px 40px 60px;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 28px;
  }
  .stat-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px;
    box-shadow: var(--shadow-sm);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .stat-card:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
  .stat-card .label {
    font-size: 11.5px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .stat-card .value {
    font-size: 29px;
    font-weight: 800;
    margin-top: 7px;
    letter-spacing: -0.01em;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 24px;
    margin-bottom: 24px;
    box-shadow: var(--shadow-sm);
  }
  .card h2 {
    margin: 0 0 16px;
    font-size: 15.5px;
    font-weight: 700;
    letter-spacing: -0.005em;
  }
  .trend-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 18px;
  }
  .trend-header h2 { margin: 0; }
  .range-pills, .filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .range-pill, .filter-pill {
    font-size: 12.5px;
    font-weight: 600;
    padding: 6px 13px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
    text-decoration: none;
    background: white;
    transition: all 0.12s ease;
  }
  .range-pill:hover, .filter-pill:hover { border-color: var(--accent); color: var(--accent); }
  .range-pill.active, .filter-pill.active {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white; border-color: transparent;
    box-shadow: 0 2px 8px rgba(67, 56, 202, 0.35);
  }
  .domain-selector {
    display: flex; align-items: center; gap: 8px; margin-bottom: 20px;
    font-size: 13.5px;
  }
  .domain-selector label { font-weight: 600; color: var(--muted); }
  .domain-selector select {
    padding: 7px 11px; border: 1px solid var(--border); border-radius: 9px;
    font-size: 13.5px; font-family: inherit; background: white; box-shadow: var(--shadow-sm);
  }
  .domain-multiselect { position: relative; display: inline-block; margin-bottom: 20px; }
  .dms-trigger {
    font-size: 13.5px; font-weight: 600; padding: 9px 15px; border: 1px solid var(--border);
    border-radius: 10px; background: white; cursor: pointer; color: var(--text);
    min-width: 200px; text-align: left; display: flex; justify-content: space-between; align-items: center; gap: 10px;
    box-shadow: var(--shadow-sm); transition: border-color 0.12s ease;
  }
  .dms-trigger:hover { border-color: var(--accent); }
  .dms-caret { color: var(--muted); }
  .dms-panel {
    position: absolute; top: calc(100% + 8px); left: 0; z-index: 20;
    background: white; border: 1px solid var(--border); border-radius: 12px;
    box-shadow: var(--shadow-md); width: 320px; padding: 12px;
  }
  .dms-search {
    width: 100%; padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 13px; font-family: inherit; margin-bottom: 8px;
  }
  .dms-search:focus { outline: 2px solid var(--accent-light); border-color: var(--accent); }
  .dms-actions { display: flex; justify-content: space-between; margin-bottom: 8px; }
  .dms-actions button {
    background: none; border: none; color: var(--accent); font-size: 12px; font-weight: 600;
    cursor: pointer; padding: 2px 4px;
  }
  .dms-list { max-height: 260px; overflow-y: auto; border-top: 1px solid #f1f2f6; border-bottom: 1px solid #f1f2f6; padding: 4px 0; }
  .dms-item { display: flex; align-items: center; gap: 8px; padding: 7px 6px; font-size: 13.5px; cursor: pointer; border-radius: 7px; }
  .dms-item:hover { background: var(--bg); }
  .dms-item input { margin: 0; accent-color: var(--accent); }
  .dms-apply {
    width: 100%; margin-top: 10px; background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white; border: none;
    padding: 10px; border-radius: 9px; font-size: 13.5px; font-weight: 700; cursor: pointer;
    box-shadow: 0 4px 12px rgba(67, 56, 202, 0.3);
  }
  .grid-2 {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 24px;
    align-items: start;
  }
  @media (max-width: 900px) {
    .grid-2 { grid-template-columns: 1fr; }
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  th {
    text-align: left;
    font-size: 11.5px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 10px 10px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 11px 10px;
    border-bottom: 1px solid #f1f2f6;
    vertical-align: middle;
  }
  td.num { text-align: right; font-weight: 600; }
  td.muted { color: var(--muted); font-size: 13px; }
  tbody tr { transition: background 0.1s ease; }
  tbody tr:hover { background: #fafafe; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: var(--accent-light); }
  a.row-link { color: inherit; text-decoration: none; display: block; }
  code {
    background: #f1f2f8;
    padding: 2px 7px;
    border-radius: 6px;
    font-size: 12px;
    font-family: 'SF Mono', Menlo, Consolas, monospace;
  }
  .esp-name { font-weight: 600; }
  .ptr { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .rate-cell { display: flex; align-items: center; gap: 10px; min-width: 160px; }
  .rate-bar { flex: 1; height: 6px; background: #eef0f5; border-radius: 4px; overflow: hidden; }
  .rate-bar-fill { height: 100%; border-radius: 4px; }
  .badge-good, .rate-bar-fill.badge-good { color: var(--good); }
  .rate-bar-fill.badge-good { background: #22c55e; }
  .badge-warn, .rate-bar-fill.badge-warn { color: var(--warn); }
  .rate-bar-fill.badge-warn { background: #f59e0b; }
  .badge-bad, .rate-bar-fill.badge-bad { color: var(--bad); }
  .rate-bar-fill.badge-bad { background: #ef4444; }
  .rate-label { font-weight: 700; font-size: 12.5px; width: 52px; }
  .issue-badge {
    display: inline-block;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--bad);
    background: var(--bad-bg);
    padding: 3px 9px;
    border-radius: 999px;
    margin: 1px 2px;
    letter-spacing: 0.01em;
  }
  .verdict {
    display: flex;
    gap: 14px;
    padding: 16px;
    border-radius: 12px;
    margin-bottom: 14px;
  }
  .verdict-good { background: var(--good-bg); }
  .verdict-bad { background: var(--bad-bg); }
  .verdict-icon {
    width: 28px; height: 28px; flex: none;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 15px;
    color: white;
  }
  .verdict-good .verdict-icon { background: var(--good); }
  .verdict-bad .verdict-icon { background: var(--bad); }
  .verdict-title { font-weight: 700; margin-bottom: 4px; }
  .verdict-body { font-size: 13.5px; color: #374151; line-height: 1.55; }
  .blocking-list { list-style: none; padding: 0; margin: 0; font-size: 13.5px; }
  .blocking-list li { padding: 9px 0; border-bottom: 1px solid #f1f2f6; }
  .blocking-list li:last-child { border-bottom: none; }
  .disposition-note {
    font-size: 13px;
    color: #374151;
    background: #f8f8fc;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    line-height: 1.55;
    margin-bottom: 14px;
  }
  .footer-note { color: var(--muted); font-size: 12px; text-align: center; margin-top: 24px; }
  .kv-table td:first-child { color: var(--muted); font-weight: 600; width: 180px; }
  .back-link { color: var(--accent); text-decoration: none; font-size: 13.5px; font-weight: 600; }
  .raw-links a {
    font-size: 12.5px; font-weight: 600; color: var(--accent); text-decoration: none;
    margin-right: 16px;
  }
  .form-hint { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .muted { color: var(--muted); }
`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234338ca'/%3E%3Cstop offset='1' stop-color='%236d28d9'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M50 4 L90 20 V48 C90 74 72 90 50 97 C28 90 10 74 10 48 V20 Z' fill='url(%23g)'/%3E%3Cpath d='M32 50 L45 63 L70 36' stroke='white' stroke-width='9' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

export function htmlHead(title: string): string {
  return `<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${FAVICON}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
  if (window.Chart) {
    Chart.defaults.font.family = "'Inter', -apple-system, 'Segoe UI', sans-serif";
    Chart.defaults.font.size = 12.5;
    Chart.defaults.color = '#6b7280';
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.titleFont = { weight: '700' };
    Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(17, 18, 34, 0.92)';
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.legend.labels.boxHeight = 12;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.scale.grid.color = '#eef0f5';
  }
</script>
<style>${SHARED_STYLES}</style>`;
}
