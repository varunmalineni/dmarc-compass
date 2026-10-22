import type { DashboardData, SourceRow } from "./dashboard-data";
import { RANGE_OPTIONS } from "./dashboard-data";
import { escapeHtml, fmtDate, fmtNumber, passRateBadgeClass, issueBadgesHtml, navHtml, htmlHead, domainMultiSelectHtml, BRAND } from "./shared-ui";

function sourceRowHtml(r: SourceRow): string {
  const rateClass = passRateBadgeClass(r.pass_rate);
  const ptrLabel = r.ptr_hostname ? escapeHtml(r.ptr_hostname) : "&mdash;";
  return `
    <tr>
      <td><span class="esp-name">${escapeHtml(r.esp_name)}</span></td>
      <td><code>${escapeHtml(r.source_ip)}</code><div class="ptr">${ptrLabel}</div></td>
      <td class="num">${fmtNumber(r.total_count)}</td>
      <td>
        <div class="rate-cell">
          <div class="rate-bar"><div class="rate-bar-fill ${rateClass}" style="width:${Math.min(100, r.pass_rate).toFixed(1)}%"></div></div>
          <span class="rate-label ${rateClass}">${r.pass_rate.toFixed(1)}%</span>
        </div>
      </td>
      <td>${issueBadgesHtml(r.issues) || '<span class="muted">&mdash;</span>'}</td>
      <td class="muted">${fmtDate(r.last_seen)}</td>
    </tr>`;
}

export function renderDashboard(data: DashboardData, allDomains: string[]): string {
  const selected = data.domainFilter ?? [];
  const navDomain = selected.length === 1 ? selected[0] : null;
  const headerTitle =
    selected.length === 0
      ? `All Domains (${fmtNumber(data.totals.domains)})`
      : selected.length === 1
        ? selected[0]
        : `${selected.length} Domains Selected`;

  const totalMessages = data.totals.messages;
  const totalPassed = data.trend.reduce((sum, p) => sum + p.passed, 0);
  const totalFailed = data.trend.reduce((sum, p) => sum + p.failed, 0);
  const overallRate = totalPassed + totalFailed > 0 ? (totalPassed / (totalPassed + totalFailed)) * 100 : 0;

  const enf = data.enforcement;
  const nextPolicy = enf.currentPolicy === "none" ? "quarantine" : enf.currentPolicy === "quarantine" ? "reject" : null;
  const failPct = enf.totalMessages > 0 ? (enf.failingMessages / enf.totalMessages) * 100 : 0;
  const dispositionHtml =
    enf.totalMessages > 0
      ? `<div class="disposition-note">
           If set to <code>p=quarantine</code> today: <strong>${fmtNumber(enf.failingMessages)}</strong> message${enf.failingMessages === 1 ? "" : "s"}
           (${failPct.toFixed(1)}% of ${fmtNumber(enf.totalMessages)} over the last ${enf.windowDays} days) would have been quarantined.
           At <code>p=reject</code>, the same messages would have been rejected outright.
         </div>`
      : "";

  const verdictHtml = enf.ready
    ? `<div class="verdict verdict-good">
         <div class="verdict-icon">&#10003;</div>
         <div>
           <div class="verdict-title">Ready to tighten enforcement</div>
           <div class="verdict-body">Every source seen in the last ${enf.windowDays} days passed DMARC alignment 100% of the time.
             ${nextPolicy ? `Current policy is <code>p=${escapeHtml(enf.currentPolicy ?? "")}</code> &mdash; safe to consider moving to <code>p=${nextPolicy}</code>.` : `Already at the strictest policy (<code>p=reject</code>).`}
           </div>
         </div>
       </div>`
    : `<div class="verdict verdict-bad">
         <div class="verdict-icon">&#33;</div>
         <div>
           <div class="verdict-title">Not ready yet</div>
           <div class="verdict-body">${enf.blockingSources.length} source${enf.blockingSources.length === 1 ? "" : "s"} failed alignment at least once in the last ${enf.windowDays} days. Fix or authorize these before moving ${enf.currentPolicy ? `past <code>p=${escapeHtml(enf.currentPolicy)}</code>` : "to a stricter policy"}.</div>
         </div>
       </div>`;

  const blockingListHtml = enf.blockingSources.length
    ? `<ul class="blocking-list">
        ${enf.blockingSources
          .sort((a, b) => a.pass_rate - b.pass_rate)
          .map(
            (s) =>
              `<li><span class="esp-name">${escapeHtml(s.esp_name)}</span> <code>${escapeHtml(s.source_ip)}</code> &mdash; <span class="${passRateBadgeClass(s.pass_rate)}">${s.pass_rate.toFixed(1)}% pass</span> ${issueBadgesHtml(s.issues)}</li>`,
          )
          .join("")}
      </ul>`
    : "";

  const trendLabels = JSON.stringify(data.trend.map((p) => p.day));
  const trendPassed = JSON.stringify(data.trend.map((p) => p.passed));
  const trendFailed = JSON.stringify(data.trend.map((p) => p.failed));

  const ESP_COLORS = ["#4338ca", "#0ea5e9", "#f59e0b", "#16a34a", "#db2777", "#7c3aed", "#94a3b8"];
  const espLabels = JSON.stringify(data.espVolume.days);
  const espDatasets = JSON.stringify(
    data.espVolume.espNames.map((name, i) => ({
      label: name,
      data: data.espVolume.series[name],
      backgroundColor: ESP_COLORS[i % ESP_COLORS.length],
      stack: "volume",
    })),
  );

  const sourcesHtml = data.sources.map(sourceRowHtml).join("");

  const rangeLinks = [
    ...RANGE_OPTIONS.map((days) => ({ label: days >= 365 ? "1y" : `${days}d`, days })),
    { label: "All time", days: null },
  ]
    .map((opt) => {
      const params = new URLSearchParams();
      if (opt.days !== null) params.set("range", String(opt.days));
      if (selected.length) params.set("domains", selected.join(","));
      const qs = params.toString();
      return `<a class="range-pill ${opt.days === data.rangeDays ? "active" : ""}" href="/${qs ? `?${qs}` : ""}">${opt.label}</a>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
${htmlHead(`${BRAND} · ${headerTitle}`)}
</head>
<body>
<header>
  <div class="eyebrow">${BRAND}</div>
  <h1>${escapeHtml(headerTitle)}</h1>
  ${navHtml("overview", navDomain)}
</header>
<main>
  ${
    data.totals.reports === 0
      ? `<div class="card" style="border-color:#c7d2fe;background:#f5f6ff">
           <h2>Welcome - no reports yet</h2>
           <p class="form-hint" style="margin:0">
             Connect the mailbox that receives your DMARC reports on the
             <a href="/admin">admin page</a>, then run a sync. Reports appear here as soon as the
             first sync completes.
           </p>
         </div>`
      : ""
  }
  ${domainMultiSelectHtml(allDomains, selected, "/")}
  <div class="stat-grid">
    <div class="stat-card"><div class="label">Reports Ingested</div><div class="value">${fmtNumber(data.totals.reports)}</div></div>
    <div class="stat-card"><div class="label">Messages Covered</div><div class="value">${fmtNumber(totalMessages)}</div></div>
    <div class="stat-card"><div class="label">Distinct Sources</div><div class="value">${fmtNumber(data.sources.length)}</div></div>
    <div class="stat-card"><div class="label">Overall Pass Rate (${escapeHtml(data.rangeLabel)})</div><div class="value" style="color:${overallRate >= 99.9 ? "var(--good)" : overallRate >= 90 ? "var(--warn)" : "var(--bad)"}">${overallRate.toFixed(1)}%</div></div>
  </div>

  <div class="card">
    <div class="trend-header">
      <h2>Authentication Trend &middot; ${escapeHtml(data.rangeLabel)}</h2>
      <div class="range-pills">${rangeLinks}</div>
    </div>
    <canvas id="trendChart" height="90"></canvas>
  </div>

  <div class="card">
    <h2>Volume by Sender &middot; ${escapeHtml(data.rangeLabel)}</h2>
    <canvas id="espChart" height="90"></canvas>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>Sending Sources &middot; ${escapeHtml(data.rangeLabel)}</h2>
      <table>
        <thead><tr><th>Sender</th><th>Source IP</th><th style="text-align:right">Messages</th><th>Pass Rate</th><th>Issues</th><th>Last Seen</th></tr></thead>
        <tbody>${sourcesHtml}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Enforcement Readiness</h2>
      ${verdictHtml}
      ${dispositionHtml}
      ${blockingListHtml}
    </div>
  </div>

  <div class="footer-note">${BRAND} &middot; aggregate reports ingested over IMAP &middot; runs on Cloudflare Workers, D1 and Containers</div>
</main>
<script>
  const ctx = document.getElementById('trendChart');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ${trendLabels},
      datasets: [
        {
          label: 'Passed',
          data: ${trendPassed},
          backgroundColor: '#22c55e',
          borderRadius: 3,
          borderSkipped: false,
          stack: 'volume',
        },
        {
          label: 'Failed',
          data: ${trendFailed},
          backgroundColor: '#ef4444',
          borderRadius: 3,
          borderSkipped: false,
          stack: 'volume',
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' } },
      scales: {
        x: { stacked: true, ticks: { autoSkip: true, maxTicksLimit: 20 }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });

  const espCtx = document.getElementById('espChart');
  new Chart(espCtx, {
    type: 'bar',
    data: {
      labels: ${espLabels},
      datasets: ${espDatasets}.map((d) => ({ ...d, borderRadius: 3, borderSkipped: false })),
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' } },
      scales: {
        x: { stacked: true, ticks: { autoSkip: true, maxTicksLimit: 20 }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
</script>
</body>
</html>`;
}
