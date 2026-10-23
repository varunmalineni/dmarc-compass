import type { TlsData } from "./tls-data";
import { TLS_LIMIT } from "./tls-data";
import { rangeLabel, type Filters } from "./filters";
import { escapeHtml, fmtDate, fmtNumber, fmtPct, emptyState, panel, exportMenu } from "./shared-ui";

export function renderTlsBody(d: TlsData, f: Filters, url: URL): string {
  const sessions = d.success + d.failure;
  const rate = sessions > 0 ? (d.success / sessions) * 100 : 100;
  const tone = rate >= 99.9 ? "v-good" : rate >= 95 ? "v-warn" : "v-bad";

  const kpis = `<div class="kpis">
    <div class="kpi"><div class="kpi-label">TLS reports</div><div class="kpi-value">${fmtNumber(d.reports)}</div><div class="kpi-foot">${escapeHtml(rangeLabel(f.range))}</div></div>
    <div class="kpi"><div class="kpi-label">Successful sessions</div><div class="kpi-value">${fmtNumber(d.success)}</div><div class="kpi-foot">Delivered over TLS</div></div>
    <div class="kpi"><div class="kpi-label">Failed sessions</div><div class="kpi-value ${d.failure ? "v-bad" : ""}">${fmtNumber(d.failure)}</div><div class="kpi-foot">Could not negotiate TLS</div></div>
    <div class="kpi"><div class="kpi-label">Success rate</div><div class="kpi-value ${sessions ? tone : ""}">${sessions ? fmtPct(rate) : "&ndash;"}</div><div class="kpi-foot">${sessions ? "of reported sessions" : "No sessions reported"}</div></div>
  </div>`;

  const empty = emptyState(
    "No SMTP TLS reports yet",
    "These come from mailbox providers that check TLS when they send <em>to</em> your domains. They start arriving after you publish a <code>_smtp._tls</code> TLS-RPT record (and usually an MTA-STS policy).",
  );

  const byDomain = d.byDomain.length
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>Domain</th><th>Policy</th><th class="num">Successful</th><th class="num">Failed</th></tr></thead><tbody>${d.byDomain
        .map(
          (r) =>
            `<tr><td><strong>${escapeHtml(r.domain)}</strong></td><td><code>${escapeHtml(r.policyType)}</code></td><td class="num">${fmtNumber(r.success)}</td><td class="num">${r.failure ? `<span class="v-bad">${fmtNumber(r.failure)}</span>` : '<span class="muted">0</span>'}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : empty;

  const failures = d.failures.length
    ? panel(
        "Recent TLS failures",
        `<div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Domain</th><th>Failure</th><th>Sending MTA</th><th>Receiving MX</th><th class="num">Sessions</th></tr></thead><tbody>${d.failures
          .map(
            (r) =>
              `<tr><td class="muted small">${fmtDate(r.at)}</td><td>${escapeHtml(r.domain)}</td><td><span class="badge bad">${escapeHtml(r.resultType)}</span></td><td>${r.ip ? `<code>${escapeHtml(r.ip)}</code>` : "&ndash;"}</td><td>${r.mx ? escapeHtml(r.mx) : "&ndash;"}</td><td class="num">${fmtNumber(r.sessions)}</td></tr>`,
          )
          .join("")}</tbody></table></div>`,
        { flush: true, sub: `Latest ${TLS_LIMIT}`, actions: exportMenu(url, [{ dataset: "tls-failures", label: "TLS failures (all)" }]) },
      )
    : "";

  return `${kpis}${panel("Policy results by domain", byDomain, {
    flush: d.byDomain.length > 0,
    actions: d.byDomain.length ? exportMenu(url, [{ dataset: "tls", label: "TLS results" }, { dataset: "tls-failures", label: "TLS failures" }]) : "",
    sub: d.byDomainTotal > TLS_LIMIT ? `Top ${TLS_LIMIT} of ${fmtNumber(d.byDomainTotal)} by failures` : escapeHtml(rangeLabel(f.range)),
  })}${failures}`;
}
