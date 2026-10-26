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
  exportMenu,
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
      return `<tr class="clickable" data-href="${escapeHtml(href)}">
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
      <div class="head-tools">${searchForm({ action: "/reports", filters: f, list, placeholder: "Search report ID or organization", extra: { filter: filter === "all" ? undefined : filter } })}
      ${exportMenu(url, [{ dataset: "reports", label: "DMARC reports" }, { dataset: "records", label: "Every record" }])}</div>
    </div>
    <div class="toolbar">${chips}</div>
    <div class="panel-body flush">${table}</div>
    ${pagination({ page: list.page, pageSize: REPORTS_PAGE_SIZE, total: data.total, noun: "reports", href: (p) => urlWith(url, { page: String(p) }) })}
  </section>`;
}

export function renderReportDetailBody(d: ReportDetail, f: Filters, mailboxName: string | null = null): { body: string; scripts: string } {
  const rawBase = `/reports/${encodeURIComponent(d.hash)}`;
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

  const body = `<a class="back" href="${withFilters("/reports", f)}">&larr; All reports</a>
  ${panel(
    "Report",
    `<table class="kv">
      <tr><td>Report ID</td><td><code>${escapeHtml(d.reportId)}</code></td></tr>
      <tr><td>Reporter</td><td>${escapeHtml(d.org)}</td></tr>
      <tr><td>Domain</td><td>${escapeHtml(d.domain)}</td></tr>
      <tr><td>Period</td><td>${fmtDate(d.dateBegin)} &ndash; ${fmtDate(d.dateEnd)}</td></tr>
      ${mailboxName ? `<tr><td>Mailbox</td><td>${escapeHtml(mailboxName)}</td></tr>` : ""}
      <tr><td>Published policy</td><td><code>p=${escapeHtml(d.policy)}</code>${d.pct !== null ? ` &middot; pct=${d.pct}` : ""}</td></tr>
    </table>
    <div class="raw-links">
      <span class="muted small">Original report</span>
      <button class="btn secondary" type="button" data-raw="xml" data-mode="view">View XML</button>
      <button class="btn secondary" type="button" data-raw="json" data-mode="view">View JSON</button>
      <button class="btn secondary" type="button" data-raw="xml" data-mode="download">Download XML</button>
      <button class="btn secondary" type="button" data-raw="json" data-mode="download">Download JSON</button>
    </div>
    <div class="raw-status" id="raw-status" role="status" aria-live="polite" hidden><span class="spinner" aria-hidden="true"></span><span id="raw-status-text"></span></div>
    <p class="hint" style="margin:10px 0 0">The original file is read from the mailbox${mailboxName ? ` <strong>${escapeHtml(mailboxName)}</strong>` : ""} through the parser, so it can take up to a minute when the parser has to switch to this mailbox. Always asks for the admin login.</p>`,
  )}
  ${panel(
    `Records (${fmtNumber(d.records.length)})`,
    `<div class="table-wrap"><table class="data"><thead><tr>
      <th>Sender</th><th>Source IP</th><th class="num">Messages</th><th>Disposition</th>
      <th>Policy DKIM</th><th>Policy SPF</th><th>Auth DKIM</th><th>Auth SPF</th><th>Header from</th><th>Issues</th>
    </tr></thead><tbody>${records}</tbody></table></div>`,
    { flush: true },
  )}
  <dialog id="raw-dialog" class="raw-dialog" aria-labelledby="raw-title">
    <div class="raw-dialog-head">
      <strong id="raw-title"></strong>
      <span class="grow"></span>
      <button class="btn secondary" type="button" id="raw-copy">Copy</button>
      <button class="btn secondary" type="button" id="raw-close">Close</button>
    </div>
    <pre id="raw-pre" tabindex="0"></pre>
  </dialog>`;

  const scripts = `
  (function(){
    var base=${JSON.stringify(rawBase).replace(/</g, "\\u003c")},box=document.getElementById('raw-status'),txt=document.getElementById('raw-status-text'),
        dlg=document.getElementById('raw-dialog'),pre=document.getElementById('raw-pre'),title=document.getElementById('raw-title'),
        buttons=document.querySelectorAll('[data-raw]'),timer=null;
    function note(text,cls){box.hidden=false;box.className='raw-status'+(cls?' '+cls:'');txt.textContent=text;box.querySelector('.spinner').hidden=!!cls}
    function setBusy(b){buttons.forEach(function(x){x.disabled=b})}
    function start(label){
      var t0=Date.now();setBusy(true);
      function tick(){var s=Math.round((Date.now()-t0)/1000);note('Fetching '+label+' from the mailbox... '+s+'s'+(s>8?' (the parser may be switching to this mailbox, which can take about a minute)':''))}
      tick();timer=setInterval(tick,1000);
    }
    function stop(){clearInterval(timer);setBusy(false)}
    function get(fmt){
      return fetch(base+'/'+fmt,{credentials:'same-origin'}).then(function(r){
        return r.text().then(function(t){
          if(r.status===401){location.href='/login?next='+encodeURIComponent(location.pathname+location.search);throw new Error('Your session ended. Redirecting to the sign-in page...');}
          if(r.status===429)throw new Error('Too many failed logins. Try again later.');
          if(!r.ok)throw new Error(t.trim()||('The request failed ('+r.status+').'));
          var m=(r.headers.get('content-disposition')||'').match(/filename="([^"]+)"/);
          return {text:t,name:m?m[1]:'report.'+fmt};
        });
      });
    }
    buttons.forEach(function(b){b.addEventListener('click',function(){
      var fmt=b.getAttribute('data-raw'),mode=b.getAttribute('data-mode'),label=fmt.toUpperCase();
      start(label);
      get(fmt).then(function(f){
        stop();
        if(mode==='view'){
          title.textContent=f.name;pre.textContent=f.text;
          if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');
          note('Opened '+f.name+'.','done');
        }else{
          var blob=new Blob([f.text],{type:'text/plain;charset=utf-8'}),a=document.createElement('a');
          a.href=URL.createObjectURL(blob);a.download=f.name;document.body.appendChild(a);a.click();a.remove();
          setTimeout(function(){URL.revokeObjectURL(a.href)},2000);
          note('Downloaded '+f.name+'.','done');
        }
      }).catch(function(err){stop();note(err.message,'error')});
    })});
    document.getElementById('raw-close').addEventListener('click',function(){dlg.close?dlg.close():dlg.removeAttribute('open')});
    document.getElementById('raw-copy').addEventListener('click',function(e){
      var b=e.target;navigator.clipboard.writeText(pre.textContent).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)},function(){b.textContent='Copy failed'});
    });
    dlg.addEventListener('click',function(e){if(e.target===dlg)dlg.close()});
  })();`;
  return { body, scripts };
}
