import type { TlsData } from "./tls-data";
import { escapeHtml, fmtDate, fmtNumber, navHtml, htmlHead, domainSelectorHtml, BRAND } from "./shared-ui";

export function renderTlsReports(data: TlsData, allDomains: string[], domainFilter: string | null): string {
  const totalSessions = data.totalSuccess + data.totalFailure;
  const successRate = totalSessions > 0 ? (data.totalSuccess / totalSessions) * 100 : 100;

  const byDomainHtml = data.byDomain
    .map(
      (d) => `
      <tr>
        <td><strong>${escapeHtml(d.policyDomain)}</strong></td>
        <td><code>${escapeHtml(d.policyType)}</code></td>
        <td class="num">${fmtNumber(d.totalSuccess)}</td>
        <td class="num" style="color:${d.totalFailure > 0 ? "var(--bad)" : "inherit"}">${fmtNumber(d.totalFailure)}</td>
      </tr>`,
    )
    .join("");

  const failuresHtml = data.recentFailures
    .map(
      (f) => `
      <tr>
        <td>${fmtDate(f.dateBegin)}</td>
        <td>${escapeHtml(f.policyDomain)}</td>
        <td><span class="issue-badge">${escapeHtml(f.resultType)}</span></td>
        <td>${f.sendingMtaIp ? `<code>${escapeHtml(f.sendingMtaIp)}</code>` : "&mdash;"}</td>
        <td>${f.receivingMxHostname ? escapeHtml(f.receivingMxHostname) : "&mdash;"}</td>
        <td class="num">${fmtNumber(f.failedSessionCount)}</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
${htmlHead(`TLS Reports · ${BRAND}`)}
</head>
<body>
<header>
  <div class="eyebrow">${BRAND}</div>
  <h1>SMTP TLS Reports</h1>
  ${navHtml("tls", domainFilter)}
</header>
<main>
  ${domainSelectorHtml(allDomains, domainFilter, "/tls-reports")}
  <div class="stat-grid">
    <div class="stat-card"><div class="label">TLS Reports</div><div class="value">${fmtNumber(data.totalReports)}</div></div>
    <div class="stat-card"><div class="label">Successful Sessions</div><div class="value">${fmtNumber(data.totalSuccess)}</div></div>
    <div class="stat-card"><div class="label">Failed Sessions</div><div class="value" style="color:${data.totalFailure > 0 ? "var(--bad)" : "var(--good)"}">${fmtNumber(data.totalFailure)}</div></div>
    <div class="stat-card"><div class="label">Success Rate</div><div class="value" style="color:${successRate >= 99.9 ? "var(--good)" : successRate >= 95 ? "var(--warn)" : "var(--bad)"}">${successRate.toFixed(1)}%</div></div>
  </div>

  <div class="card">
    <h2>MTA-STS / DANE Policy Results by Domain</h2>
    ${
      data.byDomain.length
        ? `<table>
      <thead><tr><th>Domain</th><th>Policy Type</th><th style="text-align:right">Successful</th><th style="text-align:right">Failed</th></tr></thead>
      <tbody>${byDomainHtml}</tbody>
    </table>`
        : `<p class="form-hint">No SMTP TLS reports received yet. These come from mailbox providers checking TLS/MTA-STS when sending <em>to</em> you - not every provider sends them, and they typically start arriving once an MTA-STS or TLS-RPT DNS record exists for the domain.</p>`
    }
  </div>

  ${
    data.recentFailures.length
      ? `<div class="card">
    <h2>Recent TLS Failures</h2>
    <table>
      <thead><tr><th>Date</th><th>Domain</th><th>Failure Type</th><th>Sending MTA IP</th><th>Receiving MX</th><th style="text-align:right">Sessions</th></tr></thead>
      <tbody>${failuresHtml}</tbody>
    </table>
  </div>`
      : ""
  }
</main>
</body>
</html>`;
}
