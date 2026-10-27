import type { DomainsData, DomainRow, DomainStatus } from "./domains-data";
import { DOMAINS_PAGE_SIZE } from "./domains-data";
import { withFilters, rangeLabel, type Filters, type ListState } from "./filters";
import { escapeHtml, fmtDate, fmtNumber, rateCell, emptyState, pagination, sortTh, searchForm, exportMenu, urlWith, safeJson } from "./shared-ui";
import { TAG_EDIT_JS } from "./tag-edit-ui";
import { autoColor } from "./tags";

const STATUS: Record<DomainStatus, { label: string; tone: string }> = {
  enforced: { label: "Enforced", tone: "good" },
  ready: { label: "Ready to tighten", tone: "good" },
  attention: { label: "Needs attention", tone: "bad" },
  idle: { label: "No recent traffic", tone: "neutral" },
};

/** Tag chips that filter the page to that tag when clicked. */
export function tagChips(tags: string[], url: URL, max = 4, edit?: DomainRow, colors: Record<string, string> = {}): string {
  const button = edit
    ? `<button type="button" class="tag-edit" data-domain="${escapeHtml(edit.domain)}" data-manual="${escapeHtml(JSON.stringify(edit.tags.filter((t) => !edit.autoTags.includes(t))))}" data-auto="${escapeHtml(JSON.stringify(edit.autoTags))}" aria-label="Edit the tags of ${escapeHtml(edit.domain)}" title="Edit tags">${tags.length ? "+" : "+ tag"}</button>`
    : "";
  if (tags.length === 0) return edit ? `<span class="tags">${button}</span>` : '<span class="muted">&ndash;</span>';
  const shown = tags.slice(0, max).map((t) => `<a class="tag" data-c="${escapeHtml(colors[t] ?? autoColor(t))}" href="${escapeHtml(urlWith(url, { tag: t, f: undefined, domains: undefined }))}">${escapeHtml(t)}</a>`);
  const more = tags.length > max ? `<span class="tag more" title="${escapeHtml(tags.slice(max).join(", "))}">+${tags.length - max}</span>` : "";
  return `<span class="tags">${shown.join("")}${more}${button}</span>`;
}

function row(r: DomainRow, f: Filters, url: URL, editing: TagEditing): string {
  const s = STATUS[r.status];
  // Drilling into a domain keeps the time range but replaces the domain filter.
  const href = withFilters("/", { ...f, domains: [r.domain] });
  return `<tr class="clickable" data-href="${escapeHtml(href)}">
    <td><a href="${href}" style="color:inherit;font-weight:600;text-decoration:none;white-space:nowrap">${escapeHtml(r.domain)}</a></td>
    <td>${tagChips(r.tags, url, 4, editing.editable ? r : undefined, editing.colors)}</td>
    <td>${r.policy ? `<code>p=${escapeHtml(r.policy)}</code>` : '<span class="muted">&ndash;</span>'}</td>
    <td><span class="badge ${s.tone}">${s.label}</span></td>
    <td class="num">${fmtNumber(r.total)}</td>
    <td class="num">${r.failing ? `<span class="v-bad">${fmtNumber(r.failing)}</span>` : '<span class="muted">0</span>'}</td>
    <td>${r.total ? rateCell(r.rate) : '<span class="muted">&ndash;</span>'}</td>
    <td class="num">${fmtNumber(r.sources)}</td>
    <td class="muted small">${r.lastReportAt ? fmtDate(r.lastReportAt) : "&ndash;"}</td>
  </tr>`;
}

export interface TagEditing {
  /** Signed in with the login page: show the controls that change tags. */
  editable: boolean;
  /** Existing tag names, to suggest while typing. */
  tags: string[];
  /** The colour of each tag. */
  colors: Record<string, string>;
}

export function renderDomainsBody(data: DomainsData, f: Filters, list: ListState, url: URL, editing: TagEditing = { editable: false, tags: [], colors: {} }): string {
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
          <th>Tags</th>
          ${sortTh("Policy", "policy", list, url, { defaultDir: "desc" })}
          <th>Status</th>
          ${sortTh("Messages", "messages", list, url, { num: true })}
          <th class="num">Failing</th>
          ${sortTh("Pass rate", "rate", list, url, { defaultDir: "asc" })}
          ${sortTh("Sources", "sources", list, url, { num: true })}
          ${sortTh("Last report", "last", list, url, { defaultDir: "desc" })}
        </tr></thead>
        <tbody>${data.rows.map((r) => row(r, f, url, editing)).join("")}</tbody></table></div>`
    : emptyState(list.q ? "No matching domains" : "No domains yet", list.q ? "Try a different search." : "Domains appear once reports are ingested.");

  return `${kpis}
  <section class="panel">
    <div class="panel-head"><div><h2 class="panel-title">All domains</h2><div class="panel-sub">${escapeHtml(rangeLabel(f.range))} &middot; domains with the most failing messages first</div></div>
      <div class="head-tools">${searchForm({ action: "/domains", filters: f, list, placeholder: "Search domains" })}
      ${editing.editable ? '<a class="btn secondary" href="/tags">Manage tags</a>' : ""}
      ${exportMenu(url, [{ dataset: "domains", label: "Domains" }])}</div>
    </div>
    <div class="panel-body flush">${table}</div>
    ${pagination({ page: list.page, pageSize: DOMAINS_PAGE_SIZE, total: data.total, noun: "domains", href: (p) => urlWith(url, { page: String(p) }) })}
  </section>${editing.editable ? `<script type="application/json" id="te-tags">${safeJson({ names: editing.tags, colors: editing.colors })}</script><script>${TAG_EDIT_JS}</script>` : ""}`;
}
