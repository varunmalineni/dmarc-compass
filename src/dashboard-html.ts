import type { Overview, SourceRow } from "./dashboard-data";
import { SOURCES_PAGE_SIZE } from "./dashboard-data";
import type { Filters, ListState } from "./filters";
import { rangeLabel } from "./filters";
import {
  escapeHtml,
  fmtDate,
  fmtNumber,
  fmtPct,
  rateCell,
  rateTone,
  issueBadges,
  emptyState,
  panel,
  pagination,
  sortTh,
  searchForm,
  exportMenu,
  urlWith,
  safeJson,
} from "./shared-ui";

const ESP_COLORS = ["#6366f1", "#0ea5e9", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#94a3b8"];

function delta(cur: number, prev: number | null, kind: "pct" | "pp"): string {
  if (prev === null) return `<span class="muted">Select a fixed range to compare</span>`;
  if (kind === "pct") {
    if (prev === 0) return `<span class="muted">No earlier data</span>`;
    const d = ((cur - prev) / prev) * 100;
    const cls = Math.abs(d) < 0.5 ? "flat" : "flat";
    const arrow = d > 0.5 ? "&#9650;" : d < -0.5 ? "&#9660;" : "&ndash;";
    return `<span class="delta ${cls}">${arrow} ${Math.abs(d).toFixed(0)}%</span><span>vs prior</span>`;
  }
  const d = cur - prev;
  const cls = Math.abs(d) < 0.05 ? "flat" : d > 0 ? "up" : "down";
  const arrow = d > 0.05 ? "&#9650;" : d < -0.05 ? "&#9660;" : "&ndash;";
  return `<span class="delta ${cls}">${arrow} ${Math.abs(d).toFixed(1)} pts</span><span>vs prior</span>`;
}

function share(pct: number): string {
  return pct > 0 && pct < 1 ? "<1%" : fmtPct(pct, 0);
}

function sourceRow(r: SourceRow): string {
  return `<tr>
    <td><div class="esp">${escapeHtml(r.esp)}</div></td>
    <td><code>${escapeHtml(r.ip)}</code>${r.ptr ? `<div class="ptr" title="${escapeHtml(r.ptr)}">${escapeHtml(r.ptr)}</div>` : ""}</td>
    <td class="num">${fmtNumber(r.domains)}</td>
    <td class="num">${fmtNumber(r.total)}</td>
    <td>${rateCell(r.rate)}</td>
    <td>${issueBadges(r.issues) || '<span class="muted">&ndash;</span>'}</td>
    <td class="muted small">${fmtDate(r.lastSeen)}</td>
  </tr>`;
}

function enforcementPanel(data: Overview, multi: boolean): string {
  const e = data.enforcement;
  if (e.domainsWithTraffic === 0) {
    return panel(
      "Enforcement readiness",
      emptyState("Not enough recent data", `No reports covering the last ${e.windowDays} days for this selection yet.`),
    );
  }

  const allReady = e.attention === 0 && e.nearly === 0;
  const tone = allReady ? "good" : e.attention === 0 ? "warn" : "bad";
  const icon = allReady ? "&#10003;" : "!";
  const title = allReady
    ? multi
      ? "Every domain is ready to tighten"
      : "Ready to tighten enforcement"
    : multi
      ? `${e.ready} of ${e.domainsWithTraffic} domains ready`
      : e.attention === 0
        ? "Nearly ready"
        : "Not ready yet";
  const body = allReady
    ? `No message failed DMARC alignment in the last ${e.windowDays} days.`
    : multi
      ? `${e.attention} need attention, ${e.nearly} have under 1% failing. Resolve the senders below first.`
      : `${fmtPct((e.failingMessages / Math.max(1, e.totalMessages)) * 100)} of messages failed alignment in the last ${e.windowDays} days.`;

  const mix = e.policyMix;
  const mixTotal = mix.none + mix.quarantine + mix.reject;
  const seg = (n: number, color: string) => (n ? `<span style="width:${(n / mixTotal) * 100}%;background:${color}"></span>` : "");
  const mixHtml = mixTotal
    ? `<div class="list-title">Published policy${multi ? " (domains)" : ""}</div>
       <div class="dist" role="img" aria-label="Policy mix">${seg(mix.none, "var(--warn-bar)")}${seg(mix.quarantine, "var(--accent)")}${seg(mix.reject, "var(--good-bar)")}</div>
       <div class="dist-legend">
         <span><i style="background:var(--warn-bar)"></i>none ${mix.none}</span>
         <span><i style="background:var(--accent)"></i>quarantine ${mix.quarantine}</span>
         <span><i style="background:var(--good-bar)"></i>reject ${mix.reject}</span>
       </div>`
    : "";

  const sim =
    e.failingMessages > 0
      ? `<div class="note" style="margin-top:14px">At <code>p=quarantine</code> today, <strong>${fmtNumber(e.failingMessages)}</strong> of ${fmtNumber(e.totalMessages)} messages (${fmtPct((e.failingMessages / e.totalMessages) * 100)}) from the last ${e.windowDays} days would have been quarantined; at <code>p=reject</code>, rejected.</div>`
      : "";

  const blocking = e.blocking.length
    ? `<div class="list-title">Top failing senders</div><ul class="list">${e.blocking
        .map(
          (b) =>
            `<li><span><span class="esp">${escapeHtml(b.esp)}</span> <code>${escapeHtml(b.ip)}</code></span><span class="badge bad">${fmtNumber(b.failing)} failing</span></li>`,
        )
        .join("")}</ul>`
    : "";

  return panel(
    "Enforcement readiness",
    `<div class="verdict ${tone}"><div class="verdict-icon">${icon}</div><div><div class="verdict-title">${title}</div><div class="verdict-body">${body}</div></div></div>${mixHtml}${sim}${blocking}`,
    { sub: `Last ${e.windowDays} days` },
  );
}

export function renderOverviewBody(
  data: Overview,
  f: Filters,
  list: ListState,
  url: URL,
  totalDomains: number,
): { body: string; scripts: string } {
  const c = data.current;
  const rate = c.total > 0 ? (c.passed / c.total) * 100 : 0;
  const prevRate = data.previous && data.previous.total > 0 ? (data.previous.passed / data.previous.total) * 100 : null;
  const multi = f.domains.length !== 1 && totalDomains > 1;
  const range = rangeLabel(f.range);

  const welcome =
    totalDomains === 0
      ? `<div class="callout"><h3>Welcome, no reports yet</h3><p>Connect the mailbox that receives your DMARC reports on the <a href="/admin">admin page</a>, then run a sync. Reports appear here as soon as the first sync completes.</p></div>`
      : "";

  const kpis = `<div class="kpis">
    <div class="kpi"><div class="kpi-label">Messages</div><div class="kpi-value">${fmtNumber(c.total)}</div><div class="kpi-foot">${delta(c.total, data.previous ? data.previous.total : null, "pct")}</div></div>
    <div class="kpi"><div class="kpi-label">DMARC pass rate</div><div class="kpi-value v-${c.total ? rateTone(rate) : "good"}">${c.total ? fmtPct(rate) : "&ndash;"}</div><div class="kpi-foot">${c.total ? delta(rate, prevRate, "pp") : '<span class="muted">No messages in range</span>'}</div></div>
    <div class="kpi"><div class="kpi-label">Sending sources</div><div class="kpi-value">${fmtNumber(c.sources)}</div><div class="kpi-foot">${data.failingSources ? `<span class="badge bad">${fmtNumber(data.failingSources)} failing</span>` : '<span class="badge good">all passing</span>'}</div></div>
    <div class="kpi"><div class="kpi-label">Reports ingested</div><div class="kpi-value">${fmtNumber(data.reports.count)}</div><div class="kpi-foot">${data.reports.latest ? `Latest ${fmtDate(data.reports.latest)}` : '<span class="muted">None in range</span>'}</div></div>
    ${totalDomains > 1 ? `<div class="kpi"><div class="kpi-label">Domains</div><div class="kpi-value">${fmtNumber(c.domains)}</div><div class="kpi-foot"><span>of ${fmtNumber(totalDomains)} total</span></div></div>` : ""}
  </div>`;

  const trendPanel = panel(
    "Authentication trend",
    c.total > 0 ? `<div class="chart-box"><canvas id="trend" role="img" aria-label="Daily passed and failed messages"></canvas></div>` : emptyState("No messages in this range", "Try a longer time range."),
    { sub: range },
  );

  const topSenders = Object.entries(data.esp.totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const sendersTotal = Object.values(data.esp.totals).reduce((a, b) => a + b, 0);
  const sendersPanel = panel(
    "Top senders",
    topSenders.length
      ? `<ul class="list">${topSenders
          .map(
            ([name, n]) =>
              `<li><span class="esp">${escapeHtml(name)}</span><span><strong>${fmtNumber(n)}</strong> <span class="muted">${share((n / sendersTotal) * 100)}</span></span></li>`,
          )
          .join("")}</ul>`
      : emptyState("No senders yet", "Senders appear once reports are ingested."),
    { sub: range },
  );

  const volumePanel = panel(
    "Volume by sender",
    c.total > 0 ? `<div class="chart-box"><canvas id="volume" role="img" aria-label="Daily message volume by sender"></canvas></div>` : emptyState("No messages in this range", "Try a longer time range."),
    { sub: range },
  );

  const sourcesAnchor = "sources";
  const rows = data.sources.rows.map(sourceRow).join("");
  const sourcesTable = rows
    ? `<div class="table-wrap"><table class="data">
        <thead><tr>
          ${sortTh("Sender", "sender", list, url, { anchor: sourcesAnchor })}
          ${sortTh("Source IP", "ip", list, url, { anchor: sourcesAnchor })}
          ${sortTh("Domains", "domains", list, url, { num: true, anchor: sourcesAnchor })}
          ${sortTh("Messages", "messages", list, url, { num: true, anchor: sourcesAnchor })}
          ${sortTh("Pass rate", "rate", list, url, { defaultDir: "asc", anchor: sourcesAnchor })}
          <th>Issues</th>
          ${sortTh("Last seen", "seen", list, url, { anchor: sourcesAnchor, defaultDir: "desc" })}
        </tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : emptyState(list.q ? "No matching sources" : "No sending sources", list.q ? "Try a different search." : "Nothing was sent in this range.");

  const sourcesPanel = `<section class="panel" id="${sourcesAnchor}">
    <div class="panel-head"><div><h2 class="panel-title">Sending sources</h2><div class="panel-sub">${range} &middot; failing senders first</div></div>
      <div class="head-tools">${searchForm({ action: "/", filters: f, list, placeholder: "Search IP, sender or hostname", anchor: sourcesAnchor })}
      ${exportMenu(url, [{ dataset: "sources", label: "Sending sources" }])}</div>
    </div>
    <div class="panel-body flush">${sourcesTable}</div>
    ${pagination({ page: list.page, pageSize: SOURCES_PAGE_SIZE, total: data.sources.total, noun: "sources", href: (p) => urlWith(url, { page: String(p) }) + `#${sourcesAnchor}` })}
  </section>`;

  const body = `${welcome}${kpis}
  <div class="grid-main">
    <div class="stack">${trendPanel}${volumePanel}</div>
    <div class="stack">${enforcementPanel(data, multi)}${sendersPanel}</div>
  </div>
  ${sourcesPanel}`;

  const chartData = {
    days: data.trend.days,
    passed: data.trend.passed,
    failed: data.trend.failed,
    espDays: data.esp.days,
    espNames: data.esp.names,
    espSeries: data.esp.series,
  };

  const scripts = `
  var D=${safeJson(chartData)};var COLORS=${safeJson(ESP_COLORS)};
  function axes(){return{x:{stacked:true,grid:{display:false},ticks:{autoSkip:true,maxTicksLimit:10,maxRotation:0}},y:{stacked:true,beginAtZero:true,ticks:{precision:0}}}}
  var common={responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom'}}};
  mountCharts(function(){
    var t=document.getElementById('trend');
    if(t)new Chart(t,{type:'bar',data:{labels:D.days,datasets:[
      {label:'Passed',data:D.passed,backgroundColor:'#22c55e',borderRadius:2,borderSkipped:false,stack:'v'},
      {label:'Failed',data:D.failed,backgroundColor:'#ef4444',borderRadius:2,borderSkipped:false,stack:'v'}]},
      options:Object.assign({},common,{scales:axes()})});
    var v=document.getElementById('volume');
    if(v)new Chart(v,{type:'bar',data:{labels:D.espDays,datasets:D.espNames.map(function(n,i){
      return{label:n,data:D.espSeries[n],backgroundColor:COLORS[i%COLORS.length],borderRadius:2,borderSkipped:false,stack:'v'}})},
      options:Object.assign({},common,{scales:axes()})});
  });`;

  return { body, scripts };
}
