import type { DomainsData, DomainRow, DomainStatus } from "./domains-data";
import { DOMAINS_PAGE_SIZE } from "./domains-data";
import { withFilters, rangeLabel, type Filters, type ListState } from "./filters";
import { escapeHtml, fmtDate, fmtNumber, rateCell, emptyState, pagination, sortTh, searchForm, exportMenu, urlWith } from "./shared-ui";

const STATUS: Record<DomainStatus, { label: string; tone: string }> = {
  enforced: { label: "Enforced", tone: "good" },
  ready: { label: "Ready to tighten", tone: "good" },
  attention: { label: "Needs attention", tone: "bad" },
  idle: { label: "No recent traffic", tone: "neutral" },
};

function row(r: DomainRow, f: Filters): string {
  const s = STATUS[r.status];
  // Drilling into a domain keeps the time range but replaces the domain filter.
  const href = withFilters("/", { ...f, domains: [r.domain] });
  return `<tr class="clickable" onclick="location.href='${href}'">
    <td><a href="${href}" style="color:inherit;font-weight:600;text-decoration:none;white-space:nowrap">${escapeHtml(r.domain)}</a></td>
    <td>${r.policy ? `<code>p=${escapeHtml(r.policy)}</code>` : '<span class="muted">&ndash;</span>'}</td>
    <td><span class="badge ${s.tone}">${s.label}</span></td>
    <td class="num">${fmtNumber(r.total)}</td>
    <td class="num">${r.failing ? `<span class="v-bad">${fmtNumber(r.failing)}</span>` : '<span class="muted">0</span>'}</td>
    <td>${r.total ? rateCell(r.rate) : '<span class="muted">&ndash;</span>'}</td>
    <td class="num">${fmtNumber(r.sources)}</td>
    <td class="muted small">${r.lastReportAt ? fmtDate(r.lastReportAt) : "&ndash;"}</td>
  </tr>`;
}

export function renderDomainsBody(data: DomainsData, f: Filters, list: ListState, url: URL): string {
  const s = data.summary;
  const kpis = `<div class="kpis">
    <div class="kpi"><div class="kpi-label">Domains</div><div class="kpi-value">${fmtNumber(s.domains)}</div><div class="kpi-foot">Reporting in this mailbox</div></div>
    <div class="kpi"><div class="kpi-label">Enforced</div><div class="kpi-value v-good">${fmtNumber(s.enforced)}</div><div class="kpi-foot">Publishing <code>p=reject</code></div></div>
    <div class="kpi"><div class="kpi-label">Ready to tighten</div><div class="kpi-value v-good">${fmtNumber(s.ready)}</div><div class="kpi-foot">Zero failures in ${escapeHtml(rangeLabel(f.range).toLowerCase())}</div></div>
    <div class="kpi"><div class="kpi-label">Need attention</div><div class="kpi-value ${s.attention ? "v-bad" : ""}">${fmtNumber(s.attention)}</div><div class="kpi-foot">Failing messages to resolve</div></div>
  </div>`;

  const table = data.rows.length
    ? `<div class="table-wrap"><table class="data">
        <thead><tr>
          ${sortTh("Domain", "domain", list, url)}
          ${sortTh("Policy", "policy", list, url, { defaultDir: "desc" })}
          <th>Status</th>
          ${sortTh("Messages", "messages", list, url, { num: true })}
          <th class="num">Failing</th>
          ${sortTh("Pass rate", "rate", list, url, { defaultDir: "asc" })}
          ${sortTh("Sources", "sources", list, url, { num: true })}
          ${sortTh("Last report", "last", list, url, { defaultDir: "desc" })}
        </tr></thead>
        <tbody>${data.rows.map((r) => row(r, f)).join("")}</tbody></table></div>`
    : emptyState(list.q ? "No matching domains" : "No domains yet", list.q ? "Try a different search." : "Domains appear once reports are ingested.");

  return `${kpis}
  <section class="panel">
    <div class="panel-head"><div><h2 class="panel-title">All domains</h2><div class="panel-sub">${escapeHtml(rangeLabel(f.range))} &middot; domains with the most failing messages first</div></div>
      <div class="head-tools">${searchForm({ action: "/domains", filters: f, list, placeholder: "Search domains" })}
      ${exportMenu(url, [{ dataset: "domains", label: "Domains" }])}</div>
    </div>
    <div class="panel-body flush">${table}</div>
    ${pagination({ page: list.page, pageSize: DOMAINS_PAGE_SIZE, total: data.total, noun: "domains", href: (p) => urlWith(url, { page: String(p) }) })}
  </section>`;
}
