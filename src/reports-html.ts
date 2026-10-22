import type { ReportListItem, ReportDetail } from "./reports-data";
import { escapeHtml, fmtDate, fmtNumber, issueBadgesHtml, navHtml, htmlHead, passRateBadgeClass, BRAND } from "./shared-ui";

export function renderReportsList(
  items: ReportListItem[],
  filter: "all" | "dkim" | "spf" | "dmarc",
  domainLabel: string,
  domainFilter: string | null,
): string {
  const qsFor = (f: string) => {
    const params = new URLSearchParams();
    if (f !== "all") params.set("filter", f);
    if (domainFilter) params.set("domain", domainFilter);
    const qs = params.toString();
    return `/reports${qs ? `?${qs}` : ""}`;
  };
  const filterLinks = [
    { label: "All", key: "all" as const },
    { label: "DKIM Problems", key: "dkim" as const },
    { label: "SPF Problems", key: "spf" as const },
    { label: "Any Problems", key: "dmarc" as const },
  ]
    .map((f) => `<a class="filter-pill ${f.key === filter ? "active" : ""}" href="${qsFor(f.key)}">${f.label}</a>`)
    .join("");

  const rowsHtml = items
    .map((r) => {
      const problems = [r.flagged_dkim ? "DKIM" : null, r.flagged_spf ? "SPF" : null].filter(Boolean);
      return `
        <tr class="clickable" onclick="location.href='/reports/${encodeURIComponent(r.hash)}'">
          <td><code>${escapeHtml(r.report_id)}</code></td>
          <td>${escapeHtml(r.org_name)}</td>
          <td>${escapeHtml(r.domain)}</td>
          <td>${problems.length ? problems.map((p) => `<span class="issue-badge">${p}</span>`).join(" ") : '<span class="muted">&mdash;</span>'}</td>
          <td class="num">${fmtNumber(r.records)}</td>
          <td class="muted">${fmtDate(r.date_begin)}</td>
          <td class="muted">${fmtDate(r.date_end)}</td>
        </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
${htmlHead(`DMARC Reports · ${domainLabel}`)}
</head>
<body>
<header>
  <div class="eyebrow">${BRAND}</div>
  <h1>${escapeHtml(domainLabel)}</h1>
  ${navHtml("reports", domainFilter)}
</header>
<main>
  <div class="card">
    <div class="trend-header">
      <h2>DMARC Reports (${fmtNumber(items.length)})</h2>
      <div class="filter-pills">${filterLinks}</div>
    </div>
    <table>
      <thead>
        <tr><th>Report ID</th><th>Organization</th><th>Domain</th><th>Problems</th><th style="text-align:right">Records</th><th>Begin</th><th>End</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</main>
</body>
</html>`;
}

export function renderReportDetail(detail: ReportDetail, domainLabel: string): string {
  const recordsHtml = detail.records
    .map((r) => {
      const ptrLabel = r.ptr_hostname ? escapeHtml(r.ptr_hostname) : "&mdash;";
      return `
      <tr>
        <td><span class="esp-name">${escapeHtml(r.esp_name)}</span></td>
        <td><code>${escapeHtml(r.source_ip)}</code><div class="ptr">${ptrLabel}</div></td>
        <td class="num">${fmtNumber(r.count)}</td>
        <td>${escapeHtml(r.disposition)}</td>
        <td>${r.policy_dkim ? escapeHtml(r.policy_dkim) : "&mdash;"}</td>
        <td>${r.policy_spf ? escapeHtml(r.policy_spf) : "&mdash;"}</td>
        <td>${r.auth_dkim_result ? escapeHtml(r.auth_dkim_result) : "&mdash;"}</td>
        <td>${r.auth_spf_result ? escapeHtml(r.auth_spf_result) : "&mdash;"}</td>
        <td>${escapeHtml(r.header_from)}</td>
        <td>${issueBadgesHtml(r.issues) || '<span class="muted">&mdash;</span>'}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
${htmlHead(`Report ${detail.report_id} · ${domainLabel}`)}
</head>
<body>
<header>
  <div class="eyebrow">${BRAND}</div>
  <h1>${escapeHtml(domainLabel)}</h1>
  ${navHtml("reports", detail.domain)}
</header>
<main>
  <a class="back-link" href="/reports?domain=${encodeURIComponent(detail.domain)}">&larr; Back to all reports</a>

  <div class="card" style="margin-top:16px">
    <h2>Report Header</h2>
    <table class="kv-table">
      <tr><td>Report ID</td><td><code>${escapeHtml(detail.report_id)}</code></td></tr>
      <tr><td>Organization</td><td>${escapeHtml(detail.org_name)}</td></tr>
      <tr><td>Domain</td><td>${escapeHtml(detail.domain)}</td></tr>
      <tr><td>Date Range</td><td>${fmtDate(detail.date_begin)} &ndash; ${fmtDate(detail.date_end)}</td></tr>
      <tr><td>Published Policy</td><td><code>p=${escapeHtml(detail.policy_p)}</code>${detail.policy_pct !== null ? ` &middot; pct=${detail.policy_pct}` : ""}</td></tr>
    </table>
    <div class="raw-links" style="margin-top:14px">
      <a href="/classic/dmarc-reports/${encodeURIComponent(detail.hash)}/json" target="_blank">View Raw JSON &#8599;</a>
      <a href="/classic/dmarc-reports/${encodeURIComponent(detail.hash)}/xml" target="_blank">View Raw XML &#8599;</a>
    </div>
  </div>

  <div class="card">
    <h2>Records (${fmtNumber(detail.records.length)})</h2>
    <table>
      <thead>
        <tr>
          <th>Sender</th><th>Source IP</th><th style="text-align:right">Count</th><th>Disposition</th>
          <th>Policy DKIM</th><th>Policy SPF</th><th>Auth DKIM</th><th>Auth SPF</th><th>Header From</th><th>Issues</th>
        </tr>
      </thead>
      <tbody>${recordsHtml}</tbody>
    </table>
  </div>
</main>
</body>
</html>`;
}
