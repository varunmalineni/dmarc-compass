import type { DomainSummary } from "./domains-data";
import { escapeHtml, fmtDate, fmtNumber, passRateBadgeClass, navHtml, htmlHead, BRAND } from "./shared-ui";

export function renderDomainsOverview(domains: DomainSummary[]): string {
  const rowsHtml = domains
    .map((d) => {
      const rateClass = passRateBadgeClass(d.pass_rate);
      return `
      <tr class="clickable" onclick="location.href='/?domain=${encodeURIComponent(d.domain)}'">
        <td><strong>${escapeHtml(d.domain)}</strong></td>
        <td>${d.current_policy ? `<code>p=${escapeHtml(d.current_policy)}</code>` : '<span class="muted">&mdash;</span>'}</td>
        <td class="num">${fmtNumber(d.total_count)}</td>
        <td class="num">${fmtNumber(d.distinct_sources)}</td>
        <td>
          <div class="rate-cell">
            <div class="rate-bar"><div class="rate-bar-fill ${rateClass}" style="width:${Math.min(100, d.pass_rate).toFixed(1)}%"></div></div>
            <span class="rate-label ${rateClass}">${d.pass_rate.toFixed(1)}%</span>
          </div>
        </td>
        <td class="muted">${fmtDate(d.last_report_at)}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
${htmlHead(`Domains · ${BRAND}`)}
</head>
<body>
<header>
  <div class="eyebrow">${BRAND}</div>
  <h1>Domains</h1>
  ${navHtml("domains", null)}
</header>
<main>
  <div class="card">
    <h2>All Domains (${fmtNumber(domains.length)})</h2>
    <p class="form-hint" style="margin-top:-10px;margin-bottom:16px">
      One pipeline, every domain that sends reports into this mailbox. Click a row to view that
      domain's dashboard. Built to stay usable whether this is 1 domain or 1,500.
    </p>
    <table>
      <thead>
        <tr><th>Domain</th><th>Policy</th><th style="text-align:right">Messages</th><th style="text-align:right">Sources</th><th>Pass Rate</th><th>Last Report</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</main>
</body>
</html>`;
}
