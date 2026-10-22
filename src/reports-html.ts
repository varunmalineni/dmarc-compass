import type { ReportListItem, ReportDetail, ReportFilter } from "./reports-data";
import { REPORTS_PAGE_SIZE } from "./reports-data";
import { rangeLabel, withFilters, type Filters, type ListState } from "./filters";
import {
  escapeHtml,
  fmtDate,
  fmtNumber,
  issueBadges,
  emptyState,
  panel,
  pagination,
  sortTh,
  searchForm,
  urlWith,
} from "./shared-ui";

const FILTER_LABELS: Array<[ReportFilter, string]> = [
  ["all", "All"],
  ["dkim", "DKIM problems"],
  ["spf", "SPF problems"],
  ["any", "Any problem"],
];

export function renderReportsBody(
  data: { rows: ReportListItem[]; total: number },
  f: Filters,
  list: ListState,
  filter: ReportFilter,
  url: URL,
): string {
  const chips = `<div class="chips" role="group" aria-label="Problem filter">${FILTER_LABELS.map(
    ([key, label]) =>
      `<a class="chip" href="${urlWith(url, { filter: key === "all" ? undefined : key })}" aria-current="${filter === key}">${label}</a>`,
  ).join("")}</div>`;

  const rows = data.rows
    .map((r) => {
      const href = withFilters(`/reports/${encodeURIComponent(r.hash)}`, f);
      const problems = [r.flaggedDkim ? "DKIM" : null, r.flaggedSpf ? "SPF" : null].filter(Boolean) as string[];
      return `<tr class="clickable" onclick="location.href='${href}'">
        <td><a href="${href}" style="color:inherit;text-decoration:none"><code>${escapeHtml(r.reportId.length > 28 ? r.reportId.slice(0, 26) + "…" : r.reportId)}</code></a></td>
        <td>${escapeHtml(r.org)}</td>
        <td>${escapeHtml(r.domain)}</td>
        <td>${problems.length ? problems.map((p) => `<span class="badge bad">${p}</span>`).join(" ") : '<span class="badge good">Clean</span>'}</td>
        <td class="num">${fmtNumber(r.records)}</td>
        <td class="muted small">${fmtDate(r.dateBegin)} &ndash; ${fmtDate(r.dateEnd)}</td>
      </tr>`;
    })
    .join("");

  const table = rows
    ? `<div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Report</th>
          ${sortTh("Organization", "org", list, url)}
          ${sortTh("Domain", "domain", list, url)}
          <th>Result</th>
          ${sortTh("Records", "records", list, url, { num: true })}
          ${sortTh("Period", "date", list, url, { defaultDir: "desc" })}
        </tr></thead><tbody>${rows}</tbody></table></div>`
    : emptyState(
        list.q || filter !== "all" ? "No matching reports" : "No reports in this range",
        list.q || filter !== "all" ? "Try clearing the search or the problem filter." : "Try a longer time range.",
      );

  return `<section class="panel">
    <div class="panel-head"><div><h2 class="panel-title">DMARC aggregate reports</h2><div class="panel-sub">${escapeHtml(rangeLabel(f.range))}</div></div>
      ${searchForm({ action: "/reports", filters: f, list, placeholder: "Search report ID or organization", extra: { filter: filter === "all" ? undefined : filter } })}
    </div>
    <div class="toolbar">${chips}</div>
    <div class="panel-body flush">${table}</div>
    ${pagination({ page: list.page, pageSize: REPORTS_PAGE_SIZE, total: data.total, noun: "reports", href: (p) => urlWith(url, { page: String(p) }) })}
  </section>`;
}

export function renderReportDetailBody(d: ReportDetail, f: Filters): string {
  const records = d.records
    .map(
      (r) => `<tr>
      <td><div class="esp">${escapeHtml(r.esp)}</div></td>
      <td><code>${escapeHtml(r.ip)}</code>${r.ptr ? `<div class="ptr" title="${escapeHtml(r.ptr)}">${escapeHtml(r.ptr)}</div>` : ""}</td>
      <td class="num">${fmtNumber(r.count)}</td>
      <td>${escapeHtml(r.disposition)}</td>
      <td>${r.policyDkim ? `<span class="badge ${r.policyDkim === "pass" ? "good" : "bad"}">${escapeHtml(r.policyDkim)}</span>` : "&ndash;"}</td>
      <td>${r.policySpf ? `<span class="badge ${r.policySpf === "pass" ? "good" : "bad"}">${escapeHtml(r.policySpf)}</span>` : "&ndash;"}</td>
      <td>${r.authDkim ? escapeHtml(r.authDkim) : "&ndash;"}</td>
      <td>${r.authSpf ? escapeHtml(r.authSpf) : "&ndash;"}</td>
      <td>${escapeHtml(r.headerFrom)}</td>
      <td>${issueBadges(r.issues) || '<span class="muted">&ndash;</span>'}</td>
    </tr>`,
    )
    .join("");

  return `<a class="back" href="${withFilters("/reports", f)}">&larr; All reports</a>
  ${panel(
    "Report",
    `<table class="kv">
      <tr><td>Report ID</td><td><code>${escapeHtml(d.reportId)}</code></td></tr>
      <tr><td>Reporter</td><td>${escapeHtml(d.org)}</td></tr>
      <tr><td>Domain</td><td>${escapeHtml(d.domain)}</td></tr>
      <tr><td>Period</td><td>${fmtDate(d.dateBegin)} &ndash; ${fmtDate(d.dateEnd)}</td></tr>
      <tr><td>Published policy</td><td><code>p=${escapeHtml(d.policy)}</code>${d.pct !== null ? ` &middot; pct=${d.pct}` : ""}</td></tr>
    </table>`,
  )}
  ${panel(
    `Records (${fmtNumber(d.records.length)})`,
    `<div class="table-wrap"><table class="data"><thead><tr>
      <th>Sender</th><th>Source IP</th><th class="num">Messages</th><th>Disposition</th>
      <th>Policy DKIM</th><th>Policy SPF</th><th>Auth DKIM</th><th>Auth SPF</th><th>Header from</th><th>Issues</th>
    </tr></thead><tbody>${records}</tbody></table></div>`,
    { flush: true },
  )}`;
}
