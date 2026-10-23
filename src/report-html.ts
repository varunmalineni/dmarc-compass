// The printable summary report: a standalone HTML document (no app shell, no
// scripts beyond the print button, no external requests), so it can be printed
// to PDF from the browser, saved, or emailed as a file.

import { bucketTrend, REPORT_DOMAIN_ROWS, type SummaryData } from "./report-data";
import { findings } from "./report-text";
import { rangeLabel, scopeLabel } from "./filters";
import { BRAND, escapeHtml, fmtDate, fmtNumber, fmtPct, issueBadges } from "./shared-ui";

const STATUS_LABEL = { enforced: "Enforced", ready: "Ready to tighten", attention: "Needs attention", idle: "No recent traffic" } as const;

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #eef0f5; color: #151a2c; font: 14px/1.55 -apple-system, "Segoe UI", Inter, Roboto, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.bar { position: sticky; top: 0; z-index: 5; background: #0f1226; color: #fff; display: flex; align-items: center; gap: 10px; padding: 10px 24px; }
.bar .grow { flex: 1; font-weight: 650; }
.bar a, .bar button { font: inherit; font-size: 13px; font-weight: 650; color: #fff; background: #4f46e5; border: 0; border-radius: 8px; padding: 7px 14px; cursor: pointer; text-decoration: none; }
.bar a.ghost { background: transparent; border: 1px solid #4b5170; }
.page { max-width: 880px; margin: 24px auto; background: #fff; padding: 44px 52px; border-radius: 6px; box-shadow: 0 4px 24px rgba(15,18,38,.12); }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -.01em; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .07em; color: #4f46e5; margin: 30px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e3e6ef; }
.meta { color: #5b6280; font-size: 13px; }
.kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 20px 0 4px; }
.kpi { border: 1px solid #e3e6ef; border-radius: 8px; padding: 10px 12px; }
.kpi .l { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: #5b6280; font-weight: 700; }
.kpi .v { font-size: 22px; font-weight: 750; letter-spacing: -.01em; }
.kpi .s { font-size: 11.5px; color: #5b6280; }
.good { color: #15803d; } .warn { color: #b45309; } .bad { color: #b91c1c; }
ul.find { margin: 0; padding-left: 20px; } ul.find li { margin: 4px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: #5b6280; padding: 6px 8px; border-bottom: 1.5px solid #cfd3e2; }
td { padding: 6px 8px; border-bottom: 1px solid #eceef5; vertical-align: top; }
th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; }
code { font: 11.5px ui-monospace, Menlo, monospace; background: #f1f2f8; padding: 1px 5px; border-radius: 4px; }
.badge { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: #eceef5; margin: 0 2px 2px 0; }
.badge.bad { background: #fde8e8; color: #b91c1c; } .badge.good { background: #dcfce7; color: #15803d; } .badge.warn { background: #fef3c7; color: #b45309; }
.muted { color: #6b7391; } .small { font-size: 11.5px; }
.chart { margin: 8px 0 2px; } .legend { font-size: 11.5px; color: #5b6280; display: flex; gap: 14px; }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
.foot { margin-top: 34px; padding-top: 12px; border-top: 1px solid #e3e6ef; font-size: 11.5px; color: #6b7391; }
tr { break-inside: avoid; } .kpis, .chart, .find { break-inside: avoid; }
@page { size: A4; margin: 14mm; }
@media print {
  body { background: #fff; } .bar { display: none; } .page { margin: 0; padding: 0; max-width: none; box-shadow: none; border-radius: 0; }
  h2 { break-after: avoid; }
}
@media (max-width: 720px) { .page { padding: 24px 18px; } .kpis { grid-template-columns: repeat(2, 1fr); } }
`;

function trendSvg(d: SummaryData): string {
  const t = d.overview.trend;
  if (!t.days.length || d.overview.current.total === 0) return '<p class="muted">No messages in this period.</p>';
  const b = bucketTrend(t.days, t.passed, t.failed);
  const W = 780, H = 190, L = 44, R = 6, T = 8, B = 24;
  const innerW = W - L - R, innerH = H - T - B;
  const max = Math.max(1, ...b.passed.map((p, i) => p + b.failed[i]));
  const bw = innerW / b.labels.length;
  const y = (v: number) => T + innerH - (v / max) * innerH;
  const bars = b.labels
    .map((_, i) => {
      const x = L + i * bw + bw * 0.12;
      const w = Math.max(1, bw * 0.76);
      const hp = (b.passed[i] / max) * innerH, hf = (b.failed[i] / max) * innerH;
      return `<rect x="${x.toFixed(1)}" y="${(T + innerH - hp).toFixed(1)}" width="${w.toFixed(1)}" height="${hp.toFixed(1)}" fill="#16a34a"/>` +
        (hf > 0 ? `<rect x="${x.toFixed(1)}" y="${(T + innerH - hp - hf).toFixed(1)}" width="${w.toFixed(1)}" height="${hf.toFixed(1)}" fill="#dc2626"/>` : "");
    })
    .join("");
  const ticks = [0, 0.5, 1].map((f) => {
    const v = max * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e3e6ef"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b7391">${fmtNumber(Math.round(v))}</text>`;
  }).join("");
  const idx = [0, Math.floor((b.labels.length - 1) / 2), b.labels.length - 1];
  const xl = [...new Set(idx)].map((i, k, a) => `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="${k === 0 ? "start" : k === a.length - 1 ? "end" : "middle"}" font-size="10" fill="#6b7391">${escapeHtml(b.labels[i])}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Messages passed and failed over time">${ticks}${bars}${xl}</svg>
  <div class="legend"><span><i style="background:#16a34a"></i>Passed</span><span><i style="background:#dc2626"></i>Failed</span><span>${b.unit === "week" ? "Weekly totals" : "Daily totals"}</span></div>`;
}

export function renderSummary(d: SummaryData, opts: { downloadHref: string; backHref: string }): string {
  const f = d.filters;
  const o = d.overview;
  const c = o.current;
  const rate = c.total ? (c.passed / c.total) * 100 : null;
  const prevRate = o.previous && o.previous.total ? (o.previous.passed / o.previous.total) * 100 : null;
  const scope = scopeLabel(f);
  const period = rangeLabel(f.range);
  const periodText =
    f.range === null
      ? c.firstAt ? `All time (from ${fmtDate(c.firstAt)})` : "All time"
      : `${fmtDate(d.from)} to ${fmtDate(d.to)}`;
  const s = d.domains.summary;
  const tlsSessions = d.tls.success + d.tls.failure;

  const top = d.topDomains[0] ?? null;
  const sender = d.topSenders[0] ?? null;
  const bullets = findings({
    scope: scope.toLowerCase(),
    periodLabel: period,
    messages: c.total,
    passRate: rate,
    prevPassRate: prevRate,
    domains: c.domains,
    enforced: s.enforced,
    ready: s.ready,
    attention: s.attention,
    topDomain: top ? { domain: top.domain, failing: top.failing, rate: top.rate } : null,
    topSender: sender ? { sender: sender.esp, ip: sender.ip, failing: sender.total - sender.passed } : null,
    policyChanges: d.policyChanges.length,
    newSenders: d.newSenders ? d.newSenders.length : null,
    tlsSessions,
    tlsFailed: d.tls.failure,
  });

  const tone = (r: number) => (r >= 99.9 ? "good" : r >= 95 ? "warn" : "bad");
  const delta =
    prevRate !== null && rate !== null
      ? `${rate - prevRate >= 0 ? "+" : "-"}${Math.abs(rate - prevRate).toFixed(1)} pts vs previous period`
      : "&nbsp;";
  const vol = o.previous && o.previous.total ? `${c.total >= o.previous.total ? "+" : "-"}${Math.abs(((c.total - o.previous.total) / o.previous.total) * 100).toFixed(0)}% vs previous period` : "&nbsp;";

  const domainRows = d.topDomains
    .map(
      (r) => `<tr><td><strong>${escapeHtml(r.domain)}</strong></td><td><code>p=${escapeHtml(r.policy ?? "?")}</code></td><td>${STATUS_LABEL[r.status]}</td>
      <td class="n">${fmtNumber(r.total)}</td><td class="n bad">${fmtNumber(r.failing)}</td><td class="n ${tone(r.rate)}">${fmtPct(r.rate)}</td></tr>`,
    )
    .join("");
  const moreDomains = s.attention > REPORT_DOMAIN_ROWS ? `<p class="muted small">Showing the ${REPORT_DOMAIN_ROWS} domains with the most failing messages of ${fmtNumber(s.attention)} that need attention.</p>` : "";

  const senderRows = d.topSenders
    .map(
      (r) => `<tr><td>${escapeHtml(r.esp)}</td><td><code>${escapeHtml(r.ip)}</code>${r.ptr ? `<div class="muted small">${escapeHtml(r.ptr)}</div>` : ""}</td>
      <td class="n">${fmtNumber(r.domains)}</td><td class="n">${fmtNumber(r.total)}</td><td class="n ${tone(r.rate)}">${fmtPct(r.rate)}</td><td>${issueBadges(r.issues)}</td></tr>`,
    )
    .join("");

  const changes = d.policyChanges
    .slice(0, 10)
    .map((a) => {
      const x = a.data as { domain: string; observed_on: string; from: { p: string; pct: number }; to: { p: string; pct: number }; direction: string };
      const fmt = (p: { p: string; pct: number }) => `p=${p.p}${p.pct !== 100 ? ` pct=${p.pct}` : ""}`;
      return `<tr><td><strong>${escapeHtml(x.domain)}</strong></td><td><code>${escapeHtml(fmt(x.from))}</code> to <code>${escapeHtml(fmt(x.to))}</code></td><td>${escapeHtml(x.direction)}</td><td>${escapeHtml(x.observed_on)}</td></tr>`;
    })
    .join("");

  const newRows = (d.newSenders ?? [])
    .slice(0, 10)
    .map((a) => {
      const x = a.data as { domain: string; source_ip: string; sender: string; failing_messages: number; total_messages: number };
      return `<tr><td><strong>${escapeHtml(x.domain)}</strong></td><td>${escapeHtml(x.sender)}</td><td><code>${escapeHtml(x.source_ip)}</code></td><td class="n bad">${fmtNumber(x.failing_messages)}</td></tr>`;
    })
    .join("");

  const tlsTable = d.tls.byDomain.filter((r) => r.failure > 0).slice(0, 8).map((r) => `<tr><td><strong>${escapeHtml(r.domain)}</strong></td><td><code>${escapeHtml(r.policyType)}</code></td><td class="n">${fmtNumber(r.success)}</td><td class="n bad">${fmtNumber(r.failure)}</td></tr>`).join("");

  const body = `
<div class="bar"><span class="grow">${escapeHtml(BRAND)} summary report</span>
  <a class="ghost" href="${opts.backHref}">Back to dashboard</a>
  <a class="ghost" href="${opts.downloadHref}" download>Download HTML</a>
  <button type="button" onclick="window.print()">Print / Save as PDF</button></div>
<main class="page">
  <h1>DMARC summary report</h1>
  <div class="meta">${escapeHtml(scope)} &middot; ${escapeHtml(periodText)} &middot; Generated ${escapeHtml(new Date(d.generatedAt * 1000).toISOString().replace("T", " ").slice(0, 16))} UTC</div>

  <div class="kpis">
    <div class="kpi"><div class="l">Messages</div><div class="v">${fmtNumber(c.total)}</div><div class="s">${vol}</div></div>
    <div class="kpi"><div class="l">DMARC pass rate</div><div class="v ${rate === null ? "" : tone(rate)}">${rate === null ? "n/a" : fmtPct(rate)}</div><div class="s">${delta}</div></div>
    <div class="kpi"><div class="l">Sending sources</div><div class="v">${fmtNumber(c.sources)}</div><div class="s">${fmtNumber(o.failingSources)} failing</div></div>
    <div class="kpi"><div class="l">Reports</div><div class="v">${fmtNumber(o.reports.count)}</div><div class="s">${o.reports.latest ? "latest " + fmtDate(o.reports.latest) : "&nbsp;"}</div></div>
    <div class="kpi"><div class="l">Domains</div><div class="v">${fmtNumber(c.domains)}</div><div class="s">${fmtNumber(s.enforced)} enforced</div></div>
  </div>

  <section><h2>Key findings</h2><ul class="find">${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul></section>

  <section><h2>Authentication over time</h2>${trendSvg(d)}</section>

  <section><h2>Domain status</h2>
    <p class="small muted" style="margin-top:0">${fmtNumber(s.domains)} domains: ${fmtNumber(s.enforced)} enforced (p=reject), ${fmtNumber(s.ready)} ready to tighten, ${fmtNumber(s.attention)} needing attention, ${fmtNumber(s.idle)} without recent traffic.</p>
    ${domainRows ? `<table><thead><tr><th>Domain</th><th>Policy</th><th>Status</th><th class="n">Messages</th><th class="n">Failing</th><th class="n">Pass rate</th></tr></thead><tbody>${domainRows}</tbody></table>${moreDomains}` : '<p class="muted">No domain had failing messages in this period.</p>'}
  </section>

  <section><h2>Senders with failures</h2>
    ${senderRows ? `<table><thead><tr><th>Sender</th><th>Source IP</th><th class="n">Domains</th><th class="n">Messages</th><th class="n">Pass rate</th><th>Issues</th></tr></thead><tbody>${senderRows}</tbody></table>` : '<p class="muted">Every sending source passed DMARC.</p>'}
  </section>

  ${changes ? `<section><h2>Policy changes</h2><table><thead><tr><th>Domain</th><th>Change</th><th>Direction</th><th>Observed</th></tr></thead><tbody>${changes}</tbody></table></section>` : ""}
  ${newRows ? `<section><h2>New failing senders</h2><table><thead><tr><th>Domain</th><th>Sender</th><th>Source IP</th><th class="n">Failing messages</th></tr></thead><tbody>${newRows}</tbody></table></section>` : ""}
  ${tlsSessions > 0 ? `<section><h2>SMTP TLS</h2><p class="small" style="margin-top:0">${fmtNumber(d.tls.reports)} reports, ${fmtNumber(tlsSessions)} sessions, ${tlsSessions ? fmtPct((d.tls.success / tlsSessions) * 100) : "n/a"} successful.</p>${tlsTable ? `<table><thead><tr><th>Domain</th><th>Policy</th><th class="n">Successful</th><th class="n">Failed</th></tr></thead><tbody>${tlsTable}</tbody></table>` : '<p class="muted">No TLS failures were reported.</p>'}</section>` : ""}

  <div class="foot">Generated by ${escapeHtml(BRAND)}. A message passes DMARC when SPF or DKIM passes <em>and aligns</em> with the From domain. Figures come from aggregate reports sent by receiving mail providers, which arrive a day or more after the traffic they describe, so the most recent days may be incomplete. Sender names are inferred from reverse DNS.</div>
</main>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>DMARC summary report - ${escapeHtml(scope)} - ${escapeHtml(period)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

