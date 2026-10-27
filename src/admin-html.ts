import { escapeHtml, fmtDate, fmtNumber, layout, panel, relTime, safeJson } from "./shared-ui";
import { FILTER_OPS } from "./filter-builder-ui";
import type { NotifyView } from "./notify";
import type { MailboxesView } from "./mailbox-store";
import { intervalLabel, PRESETS } from "./sync-schedule";
import type { AccountView } from "./admin-login";
import { MIN_PASSWORD } from "./credentials";
import type { LastSync } from "./app-settings";

export interface AdminViewModel {
  signedIn?: boolean;
  account: AccountView;
  notify: NotifyView;
  /** Existing tag names, offered while typing a webhook filter. */
  tags?: string[];
  mailboxes: MailboxesView;
  sync: { minutes: number; presets: readonly number[]; nextAt: number | null; lastAttempt: number | null; tooSlow: boolean; tickGap: number | null };
  publicDashboard: boolean;
  status: {
    schemaVersion: number;
    latestSchemaVersion: number;
    reports: number;
    tlsReports: number;
    domains: number;
    encryptionKeyConfigured: boolean;
    /** This page was reached over plain HTTP and the install allows it. */
    insecureHttp?: boolean;
    imapConfigured: boolean;
    lastSync: LastSync | null;
  };
}

const CSS = `
.field { margin-bottom: 18px; }
.field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.field .input { max-width: 440px; }
.pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; margin-left: 8px; }
.pill.saved { background: var(--accent-soft); color: var(--accent-text); }
.pill.secret { background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
.msg { margin-top: 12px; font-size: 13.5px; min-height: 1.2em; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
.checks { list-style: none; margin: 0 0 18px; padding: 0; }
.check { display: flex; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--border); }
.check:last-child { border-bottom: none; }
.check-icon { width: 22px; height: 22px; flex: none; border-radius: 50%; color: #fff; font-weight: 800; font-size: 12px; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
.check.ok .check-icon { background: var(--good-bar); } .check.todo .check-icon { background: var(--warn-bar); }
.check-label { font-weight: 600; }
.check-detail { font-size: 12.5px; color: var(--muted); margin-top: 2px; line-height: 1.55; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 28px; }
.switch { position: relative; width: 46px; height: 26px; flex: none; }
.switch input { opacity: 0; width: 100%; height: 100%; position: absolute; margin: 0; cursor: pointer; z-index: 1; }
.slider { position: absolute; inset: 0; background: var(--border-strong); border-radius: 999px; transition: background 0.15s; }
.slider::before { content: ""; position: absolute; width: 20px; height: 20px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform 0.15s; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(20px); }
.switch input:focus-visible + .slider { outline: 2px solid var(--accent); outline-offset: 2px; }
.switch input:disabled { cursor: wait; }
.admin-layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 28px; align-items: start; }
.field { margin: 0 0 14px; max-width: 380px; }
.field label { display: block; margin-bottom: 6px; }
.admin-tabs { position: sticky; top: 92px; display: flex; flex-direction: column; gap: 2px; }
.admin-tabs a { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; border-radius: 9px; color: var(--text-2); text-decoration: none; font-size: 13.5px; font-weight: 600; border: 1px solid transparent; }
.admin-tabs a:hover { background: var(--surface-2); color: var(--text); }
.admin-tabs a[aria-current="true"] { background: var(--accent-soft); color: var(--accent-text); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.tab-badge { min-width: 20px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; text-align: center; background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
.tab-badge.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.admin-tabs a[aria-current="true"] .tab-badge:not(.warn) { background: var(--surface); }
.admin-sections { max-width: 860px; min-width: 0; }
.admin-sections .panel:last-child { margin-bottom: 0; }
.fold { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); margin: 22px 0 0; }
.fold > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::before { content: ""; width: 7px; height: 7px; flex: none; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform 0.15s; margin: 0 4px 0 2px; }
.fold[open] > summary::before { transform: rotate(45deg); }
.fold > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fold-title { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.fold-note { font-size: 12.5px; color: var(--text-2); margin-left: auto; }
.fold-body { padding: 0 14px 12px; border-top: 1px solid var(--border); }
.fold-body .hint:first-child { margin-top: 12px; }
@media (max-width: 860px) {
  .admin-layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .admin-tabs { position: static; flex-direction: row; overflow-x: auto; gap: 6px; padding-bottom: 4px; }
  .admin-tabs a { white-space: nowrap; }
}
.rule { display: grid; grid-template-columns: 22px 1fr; gap: 4px 10px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.rule:last-of-type { border-bottom: none; }
.rule input[type=checkbox] { width: 16px; height: 16px; margin-top: 3px; accent-color: var(--accent); }
.rule-title { font-weight: 600; }
.rule-desc { grid-column: 2; font-size: 12.5px; color: var(--muted); line-height: 1.55; }
.rule-params { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
.rule-params .input { width: 84px; padding: 6px 9px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
.row .input { width: auto; max-width: 100%; }
.sub-h { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 22px 0 6px; }
.sub-h:first-child { margin-top: 0; }
.btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.hooks { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
.hook { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; align-items: center; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); }
.hook-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.hook .hook-name { width: 220px; max-width: 100%; padding: 6px 10px; font-weight: 600; }
.hook-url { font-size: 12px; }
.hook-routes { display: flex; gap: 14px; font-size: 13px; color: var(--text-2); }
.hook-status { grid-column: 1 / -1; font-size: 12.5px; color: var(--muted); }
.hook-actions { display: flex; gap: 8px; grid-row: 1; grid-column: 2; }
.hook-actions .btn { padding: 6px 12px; font-size: 12.5px; }
.btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--border)); }
.check-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.check-inline input { accent-color: var(--accent); width: 15px; height: 15px; }
.hook-scope { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 13px; color: var(--text-2); }
.hook-scope .scope-text { color: var(--text); }
.hook-filter { grid-column: 1 / -1; padding-top: 4px; }
.hook-filter .row { margin: 10px 0 0; }
#hook-add .fold { margin-top: 12px; background: var(--surface); }
.hook-add { padding: 14px; border: 1px dashed var(--border-strong); border-radius: 10px; margin-bottom: 8px; }
.hook-add-title { font-weight: 600; margin-bottom: 10px; }
@media (max-width: 700px) { .hook { grid-template-columns: 1fr; } .hook-actions { grid-row: auto; grid-column: auto; } }
pre.preview { margin: 12px 0 0; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
`;

function check(ok: boolean, label: string, detail: string): string {
  return `<li class="check ${ok ? "ok" : "todo"}"><span class="check-icon">${ok ? "&#10003;" : "!"}</span><div><div class="check-label">${label}</div><div class="check-detail">${detail}</div></div></li>`;
}

export function renderAdmin(vm: AdminViewModel, url: URL): string {
  const s = vm.status;

  const lastSync = s.lastSync
    ? `${s.lastSync.ok ? "Succeeded" : "Failed"} ${relTime(s.lastSync.at)} &middot; ${escapeHtml(s.lastSync.summary)}`
    : `Has not run yet. The scheduled sync runs ${vm.sync.minutes === 15 ? "every 15 minutes" : "on the schedule below"}, or run one now.`;

  const status = panel(
    "Setup status",
    `<ul class="checks">
      ${check(true, "Database connected", `Schema v${s.schemaVersion} of v${s.latestSchemaVersion}. Tables are created and upgraded automatically.`)}
      ${check(
        s.encryptionKeyConfigured,
        "Config encryption key",
        s.encryptionKeyConfigured
          ? "Mailbox credentials saved here are encrypted before they are stored."
          : "Missing. Without it, credentials can't be saved from this page. Run <code>openssl rand -base64 32 | npx wrangler secret put CONFIG_ENCRYPTION_KEY</code>.",
      )}
      ${s.insecureHttp ? check(false, "Sign-in over plain HTTP", "Anyone on the network can read your password and session. Put this behind HTTPS (a reverse proxy or ingress), then remove <code>ALLOW_INSECURE_HTTP</code>.") : ""}
      ${check(s.imapConfigured, "Mailbox connected", s.imapConfigured ? "Host, user and password are set." : "Not configured yet. Enter the mailbox that receives your DMARC reports below.")}
      ${check(Boolean(s.lastSync?.ok), "Last sync", lastSync)}
      ${check(
        s.reports > 0,
        "Data",
        s.reports > 0
          ? `${fmtNumber(s.reports)} DMARC reports across ${fmtNumber(s.domains)} domain${s.domains === 1 ? "" : "s"}, ${fmtNumber(s.tlsReports)} TLS reports.`
          : "No reports ingested yet. They appear after the first successful sync.",
      )}
    </ul>
    <button class="btn secondary" id="sync-btn" type="button">Run sync now</button>
    <div class="msg" id="sync-msg" role="status"></div>`,
  );

  const sy = vm.sync;
  const options = [...new Set([...PRESETS, sy.minutes])].sort((a, b) => a - b);
  const schedule = panel(
    "Sync schedule",
    `<p class="hint" style="margin-top:0">How often the dashboard checks the mailboxes for new reports. Receiving providers only send reports about once a day, so a short interval mostly finds nothing. A long interval can let the container sleep between syncs.</p>
    <div class="row">
      <label for="sync-minutes" style="font-weight:600">Sync every</label>
      <select class="input" id="sync-minutes" style="width:auto">${options
        .map((m) => `<option value="${m}"${m === sy.minutes ? " selected" : ""}>${intervalLabel(m)}</option>`)
        .join("")}</select>
      <button class="btn" id="sync-save" type="button">Save</button>
    </div>
    <div class="hint" id="sync-next"></div>
    <div class="warn-box" id="sync-slow" hidden>The deployed schedule only wakes the Worker about every <span id="sync-gap"></span> minutes, so a shorter interval cannot be met. Set <code>triggers.crons</code> to <code>["*/5 * * * *"]</code> in your wrangler config and run <code>npm run deploy</code>.</div>
    <div class="msg" id="sync-save-msg" role="status"></div>`,
  );

  const visibility = panel(
    "Dashboard visibility",
    `<div class="toggle-row">
      <div>
        <div style="font-weight:600" id="vis-label">Allow anyone with the link to view the dashboard</div>
        <div class="hint" style="margin-top:4px">
          Off (default): every page asks for the admin login. On: the read-only pages (Overview, Domains, reports, TLS, map) are public.
          This page always requires login. Public pages show your sending IPs and pass rates, so enable this only if that is acceptable.
        </div>
      </div>
      <label class="switch"><input type="checkbox" id="public-toggle" aria-labelledby="vis-label" ${vm.publicDashboard ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="msg" id="vis-msg" role="status"></div>`,
  );

  const ac = vm.account;
  const account = panel(
    "Admin login",
    `<p class="hint" style="margin-top:0">${
      ac.source === "stored"
        ? `The login was changed on this page${ac.changedAt ? ` on <span id="acct-when">${new Date(ac.changedAt * 1000).toISOString().slice(0, 10)}</span>` : ""}. The password is stored hashed and can't be shown again.`
        : "This is the login the app was deployed with (<code>ADMIN_USER</code> / <code>ADMIN_PASSWORD</code>). Changing it here stores a new one in the database, which then takes precedence."
    } Signed in as <b id="acct-user">${escapeHtml(ac.user)}</b>.</p>
    <form id="acct-form" autocomplete="on" novalidate>
      <input type="text" name="username" value="${escapeHtml(ac.user)}" autocomplete="username" hidden aria-hidden="true" tabindex="-1">
      <div class="field"><label for="acct-current" style="font-weight:600">Current password</label>
        <input class="input" id="acct-current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="acct-user-new" style="font-weight:600">User name</label>
        <input class="input" id="acct-user-new" type="text" value="${escapeHtml(ac.user)}" autocomplete="off" maxlength="64" spellcheck="false" autocapitalize="none"></div>
      <div class="field"><label for="acct-new" style="font-weight:600">New password <span class="hint" style="font-weight:400">(leave empty to keep the current one)</span></label>
        <input class="input" id="acct-new" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}"></div>
      <div class="field"><label for="acct-confirm" style="font-weight:600">Repeat the new password</label>
        <input class="input" id="acct-confirm" type="password" autocomplete="new-password"></div>
      <button class="btn" id="acct-save" type="submit">Save login</button>
      <div class="msg" id="acct-msg" role="status"></div>
    </form>
    <p class="hint">At least ${MIN_PASSWORD} characters. Saving signs out every other session; scripts using HTTP Basic Auth need the new login.</p>
    <details><summary><b>Forgot the password?</b></summary>
      <p class="hint">Remove the stored login so the one the app was deployed with works again. Self-hosted: <code>node dist/server.mjs --reset-admin</code> inside the container (for example <code>docker compose exec dmarc-compass node dist/server.mjs --reset-admin</code>).
      Cloudflare: <code>npx wrangler d1 execute DB -c wrangler.local.jsonc --remote --command "DELETE FROM app_settings WHERE key = 'admin_login'"</code>.</p>
    </details>`,
  );

  const mb = vm.mailboxes;
  const locked = mb.canSave ? "" : "disabled";
  const imap = panel(
    "Mailboxes",
    `<p class="hint" style="margin-top:0">The mailboxes that receive your DMARC and TLS-RPT reports (the <code>rua=</code> and <code>_smtp._tls</code> addresses). Reports from every mailbox are combined: one view, sorted by domain, with a reported-once guarantee if the same report reaches two of them.
    One parser reads them in turns, so each mailbox is refreshed once per sync run (see Sync schedule), and original XML/JSON for a report from a mailbox that is not loaded takes a minute to fetch.</p>
    ${mb.canSave ? "" : '<div class="warn-box">Saving is disabled until the <code>CONFIG_ENCRYPTION_KEY</code> secret is set (see Setup status).</div>'}
    <div class="hooks" id="mailboxes"></div>
    <div class="hint" id="mailboxes-empty" hidden>No mailbox yet. Add the one that receives your reports below.</div>
    <form class="hook-add" id="mb-form" autocomplete="off">
      <div class="hook-add-title" id="mb-title">Add a mailbox</div>
      <div class="row">
        <label for="mb-name" class="sr-only">Nickname</label>
        <input class="input" id="mb-name" type="text" maxlength="40" placeholder="Nickname (optional)" style="width:200px" ${locked}>
        <label for="mb-host" class="sr-only">IMAP host</label>
        <input class="input" id="mb-host" type="text" placeholder="imap.example.com" style="width:240px" ${locked}>
        <label for="mb-folder" class="sr-only">Folder</label>
        <input class="input" id="mb-folder" type="text" placeholder="Folder (blank = INBOX)" style="width:200px" ${locked}>
      </div>
      <div class="row">
        <label for="mb-user" class="sr-only">User</label>
        <input class="input" id="mb-user" type="text" placeholder="dmarc@example.com" style="width:260px" autocomplete="off" ${locked}>
        <label for="mb-pass" class="sr-only">Password</label>
        <input class="input" id="mb-pass" type="password" placeholder="Password or app password" style="width:260px" autocomplete="new-password" ${locked}>
        <button class="btn" id="mb-save" type="submit" ${locked}>Add mailbox</button>
        <button class="btn secondary" id="mb-cancel" type="button" hidden>Cancel</button>
      </div>
      <div class="hint">Folder names are case-sensitive. Use an app-specific password where your provider offers one. Passwords are stored encrypted and never shown again. Up to ${mb.limit} mailboxes.</div>
    </form>
    <div class="msg" id="mb-msg" role="status"></div>`,
  );

  const n = vm.notify;
  const rulesOn = Object.values(n.config.rules).filter((r) => r.on).length;
  const notifications = panel(
    "Notifications",
    `<p class="hint" style="margin-top:0">Alerts and a periodic digest, delivered to webhooks: Slack-compatible incoming webhooks (Slack, Mattermost, and others that accept the same format), or any URL that accepts a JSON POST (your own service, n8n, Zapier, a SIEM). Add as many as you like and choose which messages each one receives. Nothing is sent until a webhook is added.</p>
    ${n.canSaveWebhook ? "" : '<div class="warn-box">Saving a webhook here needs the <code>CONFIG_ENCRYPTION_KEY</code> secret (see Setup status). You can instead set a <code>SLACK_WEBHOOK_URL</code> Worker secret, which appears here as a read-only webhook.</div>'}

    <div class="sub-h">Webhooks</div>
    <div class="hooks" id="hooks"></div>
    <div class="hint" id="hooks-empty" hidden>No webhook yet. In Slack, create an Incoming Webhook for the channel you want, then add its URL below.</div>
    <form class="hook-add" id="hook-add" autocomplete="off">
      <div class="hook-add-title">Add a webhook</div>
      <div class="row">
        <label for="h-type" class="sr-only">Type</label>
        <select class="input" id="h-type" ${n.canSaveWebhook ? "" : "disabled"}>
          <option value="slack">Slack-compatible</option>
          <option value="json">JSON (any URL)</option>
        </select>
        <label for="h-name" class="sr-only">Nickname</label>
        <input class="input" id="h-name" type="text" maxlength="40" placeholder="Nickname (optional), e.g. #dmarc-alerts" style="width:260px" ${n.canSaveWebhook ? "" : "disabled"}>
        <label for="h-url" class="sr-only">Webhook URL</label>
        <input class="input" id="h-url" type="password" placeholder="https://hooks.slack.com/services/..." style="width:340px" ${n.canSaveWebhook ? "" : "disabled"}>
        <button class="btn" id="h-add" type="submit" ${n.canSaveWebhook ? "" : "disabled"}>Add webhook</button>
      </div>
      <div class="row" id="h-secret-row" hidden>
        <label for="h-secret" class="sr-only">Signing secret</label>
        <input class="input" id="h-secret" type="password" autocomplete="off" placeholder="Signing secret (optional): requests carry an HMAC-SHA256 signature" style="width:520px">
      </div>
      <div class="row" style="margin-bottom:0">
        <span class="muted small">Send to this webhook:</span>
        <label class="check-inline"><input type="checkbox" id="h-alerts" checked> Alerts</label>
        <label class="check-inline"><input type="checkbox" id="h-digest" checked> Digest</label>
      </div>
      <details class="fold" id="h-filter-fold">
        <summary><span class="fold-title">Only some domains</span><span class="fold-note" id="h-filter-note">every domain</span></summary>
        <div class="fold-body">
          <div class="hint">Send this webhook only the alerts and digest for domains that match: for example, the domains tagged <code>emea</code> to the EMEA channel. Leave empty to send everything. Alerts about syncing are not about a domain, so they always go to every webhook.</div>
          <div id="h-filter-builder"></div>
        </div>
      </details>
    </form>
    <div class="hint">URLs are stored encrypted and never shown again; only a masked form appears. Up to ${n.hookLimit} webhooks.</div>
    ${n.baseUrlKnown ? "" : '<div class="hint">Messages will link back to this dashboard once you have opened this page once more after adding a webhook.</div>'}

    <details class="fold" id="rules-fold">
      <summary><span class="fold-title">Alert rules</span><span class="fold-note" id="rules-note">${rulesOn} of 4 on</span></summary>
      <div class="fold-body">
    <div class="hint" style="margin:0 0 4px">Checked after every sync. Each event is reported once.</div>
    <div class="rule">
      <input type="checkbox" id="r-nfs" aria-labelledby="r-nfs-t">
      <div class="rule-title" id="r-nfs-t">New failing sender</div>
      <div class="rule-desc">A source that fails DMARC for a domain it has not been seen on before. Grouped into one message.</div>
      <div class="rule-params">at least <input class="input" id="r-nfs-min" type="number" min="1" aria-label="Minimum failing messages"> failing messages</div>
    </div>
    <div class="rule">
      <input type="checkbox" id="r-drop" aria-labelledby="r-drop-t">
      <div class="rule-title" id="r-drop-t">Pass rate dropped</div>
      <div class="rule-desc">A domain's pass rate over the last 7 days is lower than the 7 days before.</div>
      <div class="rule-params">by <input class="input" id="r-drop-pts" type="number" min="1" max="100" aria-label="Points of drop"> points or more, with at least <input class="input" id="r-drop-min" type="number" min="1" aria-label="Minimum messages"> messages in each week</div>
    </div>
    <div class="rule">
      <input type="checkbox" id="r-pol" aria-labelledby="r-pol-t">
      <div class="rule-title" id="r-pol-t">Policy changed</div>
      <div class="rule-desc">A domain's published <code>p=</code> or <code>pct=</code> changed, for example <code>none</code> to <code>quarantine</code>.</div>
    </div>
    <div class="rule">
      <input type="checkbox" id="r-sync" aria-labelledby="r-sync-t">
      <div class="rule-title" id="r-sync-t">Sync problem</div>
      <div class="rule-desc">Syncing is failing or has stopped. Sends a note when it recovers.</div>
      <div class="rule-params">alert after <input class="input" id="r-sync-min" type="number" min="30" aria-label="Minutes without a sync"> minutes without a successful sync</div>
    </div>
      </div>
    </details>

    <div class="sub-h">Digest</div>
    <div class="row">
      <label for="d-mode" class="sr-only">Digest frequency</label>
      <select class="input" id="d-mode">
        <option value="off">Off</option>
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
        <option value="monthly">Every month</option>
        <option value="days">Every N days</option>
      </select>
      <span id="d-every-wrap" hidden>every <input class="input" id="d-every" type="number" min="1" max="365" style="width:76px" aria-label="Number of days"> days</span>
      <span id="d-weekday-wrap" hidden>on <select class="input" id="d-weekday" aria-label="Day of the week"></select></span>
      <span id="d-dom-wrap" hidden>on day <input class="input" id="d-dom" type="number" min="1" max="28" style="width:76px" aria-label="Day of the month"> of the month</span>
      <span id="d-time-wrap" hidden>at <select class="input" id="d-hour" aria-label="Hour"></select> <select class="input" id="d-tz" aria-label="Time zone" style="max-width:260px"></select></span>
    </div>
    <div class="hint" id="d-next"></div>

    <div class="btn-row">
      <button class="btn" id="n-save" type="button">Save notification settings</button>
      <button class="btn secondary" id="n-digest" type="button">Send digest now</button>
      <button class="btn secondary" id="n-preview" type="button">Preview alerts</button>
    </div>
    <div class="msg" id="n-msg" role="status"></div>
    <pre class="preview" id="n-preview-out" hidden></pre>`,
  );

  const todo =
    (s.encryptionKeyConfigured ? 0 : 1) + (s.insecureHttp ? 1 : 0) + (s.imapConfigured ? 0 : 1) + (s.lastSync?.ok ? 0 : 1) + (s.reports > 0 ? 0 : 1);
  const tabs: Array<{ id: string; label: string; badge: string; warn?: boolean; html: string }> = [
    { id: "status", label: "Setup status", badge: todo ? String(todo) : "", warn: true, html: status + schedule },
    { id: "mailboxes", label: "Mailboxes", badge: mb.rows.length ? String(mb.rows.length) : "", html: imap },
    { id: "visibility", label: "Dashboard visibility", badge: "", html: visibility },
    { id: "account", label: "Account", badge: "", html: account },
    { id: "notifications", label: "Notifications", badge: n.hooks.length ? String(n.hooks.length) : "", html: notifications },
  ];
  const adminBody = `<div class="admin-layout">
    <nav class="admin-tabs" aria-label="Admin sections">${tabs
      .map(
        (t) =>
          `<a href="#${t.id}" data-tab="${t.id}">${escapeHtml(t.label)}<span class="tab-badge${t.warn ? " warn" : ""}" id="badge-${t.id}"${t.badge ? "" : " hidden"}>${t.badge}</span></a>`,
      )
      .join("")}</nav>
    <div class="admin-sections">${tabs.map((t) => `<section class="admin-section" id="tab-${t.id}" data-tab="${t.id}" aria-label="${escapeHtml(t.label)}">${t.html}</section>`).join("")}</div>
  </div>`;

  const scripts = `
  // Section tabs. Without scripts every section is shown, one after another.
  function oldTagsLink(){if(location.hash==='#tags')location.replace('/tags')}
  oldTagsLink();window.addEventListener('hashchange',oldTagsLink);
  var TAB_IDS=${safeJson(tabs.map((t) => t.id))};
  // Setup status is drawn by the server. When a mailbox or a sync has changed what it
  // reports, the page reloads when you open that tab, so it never shows old information.
  var statusStale=false;
  function showTab(id){
    if(TAB_IDS.indexOf(id)<0)id=TAB_IDS[0];
    if(id==='status'&&statusStale){statusStale=false;location.reload();return}
    document.querySelectorAll('.admin-section').forEach(function(sec){sec.hidden=sec.getAttribute('data-tab')!==id});
    document.querySelectorAll('.admin-tabs a').forEach(function(a){if(a.getAttribute('data-tab')===id)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current')});
  }
  function setBadge(id,n){var b=document.getElementById('badge-'+id);if(!b)return;b.textContent=n?String(n):'';b.hidden=!n}
  showTab(location.hash.slice(1));
  window.addEventListener('hashchange',function(){showTab(location.hash.slice(1))});
  // Every write carries a custom header. A cross-site <form> can't set one
  // without a CORS preflight (which this app never allows), which is what
  // protects these endpoints from CSRF alongside Basic Auth.
  function post(body){return fetch('/admin',{method:'POST',headers:{'content-type':'application/json','x-settings-request':'1'},body:JSON.stringify(body)}).then(function(r){return r.text().then(function(t){if(r.status===401){location.href='/login?next=/admin';throw new Error('Your session ended. Redirecting to the sign-in page...');}if(!r.ok)throw new Error(t);return t})})}
  function say(el,ok,t){el.className='msg '+(ok?'ok':'err');el.textContent=t}
  document.getElementById('public-toggle').addEventListener('change',function(e){
    var t=e.target,m=document.getElementById('vis-msg');t.disabled=true;m.className='msg';m.textContent='Saving...';
    post({public_dashboard:t.checked})
      .then(function(){say(m,true,t.checked?'Dashboard is now public.':'Dashboard now requires login.')})
      .catch(function(err){t.checked=!t.checked;say(m,false,'Failed to save: '+err.message)}).finally(function(){t.disabled=false});
  });
  document.getElementById('sync-btn').addEventListener('click',function(e){
    var b=e.target,m=document.getElementById('sync-msg');b.disabled=true;m.className='msg';
    m.textContent='Syncing. With several mailboxes this can take a few minutes: the parser reads them one at a time...';
    post({action:'sync'}).then(function(t){statusStale=true;var o=JSON.parse(t);var bad=(o.mailboxes||[]).filter(function(x){return !x.ok});say(m,!bad.length,'Done: '+o.newReports+' new DMARC reports, '+o.newTlsReports+' new TLS reports'+(bad.length?'. Problems: '+bad.map(function(x){return x.name+' ('+x.error+')'}).join('; '):'')+'. Reload to refresh the status above.')})
      .catch(function(err){statusStale=true;say(m,false,'Sync failed: '+err.message)}).finally(function(){b.disabled=false});
  });
  (function(){
    var $=function(id){return document.getElementById(id)};
    var f=$('acct-form');if(!f)return;
    f.addEventListener('submit',function(e){
      e.preventDefault();
      var m=$('acct-msg'),b=$('acct-save'),np=$('acct-new').value;
      if(!$('acct-current').value){say(m,false,'Enter your current password.');return}
      if(np!==$('acct-confirm').value){say(m,false,'The two new passwords are not the same.');return}
      b.disabled=true;m.className='msg';m.textContent='Saving...';
      post({action:'account_save',currentPassword:$('acct-current').value,newUser:$('acct-user-new').value,newPassword:np}).then(function(t){
        var a=JSON.parse(t).account;
        $('acct-user').textContent=a.user;
        ['acct-current','acct-new','acct-confirm'].forEach(function(id){$(id).value=''});
        say(m,true,'Saved. Other sessions were signed out; you stay signed in here.');
      }).catch(function(err){say(m,false,err.message.trim())}).finally(function(){b.disabled=false});
    });
  })();
  var SY=${safeJson(sy)};
  (function(){
    var $=function(id){return document.getElementById(id)};
    function fmtNext(){
      var el=$('sync-next');
      if(SY.nextAt===null){el.textContent='The next sync is due on the next wake-up (within 5 minutes).';return}
      var mins=Math.max(1,Math.round((SY.nextAt-Date.now()/1000)/60));
      el.textContent='Next sync: about '+new Date(SY.nextAt*1000).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})+' ('+(mins<90?'in '+mins+' min':'in about '+Math.round(mins/60)+' h')+').';
    }
    function warn(){var w=$('sync-slow');w.hidden=!SY.tooSlow;if(SY.tickGap)$('sync-gap').textContent=String(Math.round(SY.tickGap/60))}
    fmtNext();warn();
    $('sync-save').addEventListener('click',function(){
      var b=$('sync-save'),m=$('sync-save-msg'),v=Number($('sync-minutes').value);
      b.disabled=true;m.className='msg';m.textContent='Saving...';
      post({action:'sync_schedule_save',minutes:v}).then(function(t){
        SY=JSON.parse(t);fmtNext();warn();
        say(m,true,'Saved. Syncs now run '+(v===5?'every 5 minutes':v<60?'every '+v+' minutes':v===60?'every hour':v%60===0?'every '+(v/60)+' hours':'every '+v+' minutes')+'.'+' The container may restart once on the next sync to pick this up.');
      }).catch(function(err){say(m,false,'Failed to save: '+err.message)}).finally(function(){b.disabled=false});
    });
  })();
  var MB=${safeJson({ rows: mb.rows, canSave: mb.canSave })};
  (function(){
    var $=function(id){return document.getElementById(id)};
    var box=$('mailboxes'),msg=$('mb-msg'),editing=null;
    function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
    function rel(at){var s=Math.max(0,Date.now()/1000-at);if(s<90)return 'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<172800)return Math.round(s/3600)+' hours ago';return Math.round(s/86400)+' days ago'}
    function render(){
      box.textContent='';$('mailboxes-empty').hidden=MB.rows.length>0;setBadge('mailboxes',MB.rows.length);
      MB.rows.forEach(function(m){
        var row=el('div','hook');row.setAttribute('data-id',m.id);
        var main=el('div','hook-main');
        main.appendChild(el('strong','',m.name));
        main.appendChild(el('code','hook-url',m.user+' @ '+m.host+' / '+(m.folder||'INBOX')));
        if(!m.enabled)main.appendChild(el('span','pill secret','paused'));
        if(m.source==='legacy')main.appendChild(el('span','pill secret','original'));
        row.appendChild(main);
        var act=el('div','hook-actions');
        [['test','Test'],['edit','Edit'],['toggle',m.enabled?'Pause':'Resume']].forEach(function(a){var b=el('button','btn secondary',a[1]);b.type='button';b.setAttribute('data-act',a[0]);act.appendChild(b)});
        var r=el('button','btn secondary danger','Remove');r.type='button';r.setAttribute('data-act','remove');act.appendChild(r);
        row.appendChild(act);
        var st=el('div','hook-status');
        st.appendChild(document.createTextNode(m.reports.toLocaleString('en-US')+' DMARC report'+(m.reports===1?'':'s')+' stored. '));
        if(m.result){var ok=el('span',m.result.ok?'v-good':'v-bad',m.result.ok?'OK':'Problem');st.appendChild(document.createTextNode('Last check: '));st.appendChild(ok);st.appendChild(document.createTextNode(' '+rel(m.result.at)+' \u00b7 '+m.result.detail))}
        else st.appendChild(document.createTextNode('Not checked yet.'));
        row.appendChild(st);box.appendChild(row);
      });
    }
    render();
    function busy(b){box.querySelectorAll('button').forEach(function(e){e.disabled=b});$('mb-save').disabled=b||!MB.canSave}
    function run(label,body,done){
      busy(true);msg.className='msg';msg.textContent=label;
      post(body).then(function(t){var r=JSON.parse(t);MB.rows=r.mailboxes.rows;render();statusStale=true;done(r)})
        .catch(function(err){say(msg,false,err.message);return post({action:'mailboxes_state'}).then(function(t){MB.rows=JSON.parse(t).mailboxes.rows;render()}).catch(function(){})})
        .finally(function(){busy(false)});
    }
    function reset(){editing=null;['mb-name','mb-host','mb-folder','mb-user','mb-pass'].forEach(function(i){$(i).value=''});$('mb-title').textContent='Add a mailbox';$('mb-save').textContent='Add mailbox';$('mb-cancel').hidden=true;$('mb-pass').placeholder='Password or app password'}
    $('mb-cancel').addEventListener('click',reset);
    box.addEventListener('click',function(e){
      var b=e.target.closest('button[data-act]');if(!b)return;
      var id=b.closest('.hook').getAttribute('data-id');
      var m=MB.rows.filter(function(x){return x.id===id})[0];var act=b.getAttribute('data-act');
      if(act==='test'){
        busy(true);msg.className='msg';msg.textContent='Connecting to '+m.host+'...';
        post({action:'mailbox_test',id:id}).then(function(t){var r=JSON.parse(t);MB.rows=r.mailboxes.rows;render();statusStale=true;say(msg,true,m.name+': login works and the folder opened.')})
          .catch(function(err){say(msg,false,m.name+': '+err.message);return post({action:'mailboxes_state'}).then(function(t){MB.rows=JSON.parse(t).mailboxes.rows;render()}).catch(function(){})})
          .finally(function(){busy(false)});
      }else if(act==='edit'){
        editing=id;$('mb-name').value=m.name;$('mb-host').value=m.host;$('mb-folder').value=m.folder;$('mb-user').value=m.user;$('mb-pass').value='';
        $('mb-pass').placeholder='Leave blank to keep the current password';$('mb-title').textContent='Edit '+m.name;$('mb-save').textContent='Save changes';$('mb-cancel').hidden=false;
        $('mb-form').scrollIntoView({block:'center'});
      }else if(act==='toggle'){
        run(m.enabled?'Pausing...':'Resuming...',{action:'mailbox_update',id:id,mailbox:{enabled:!m.enabled}},function(){say(msg,true,m.enabled?m.name+' paused: it is skipped until resumed.':m.name+' resumed.')});
      }else if(act==='remove'){
        if(!confirm('Remove '+m.name+'? Its reports already stored here are kept; no new ones will be read from it.'))return;
        run('Removing...',{action:'mailbox_remove',id:id},function(){say(msg,true,'Removed '+m.name+'.');if(editing===id)reset()});
      }
    });
    $('mb-form').addEventListener('submit',function(e){
      e.preventDefault();
      var mailbox={name:$('mb-name').value,host:$('mb-host').value,folder:$('mb-folder').value,user:$('mb-user').value,password:$('mb-pass').value};
      if(editing){run('Saving...',{action:'mailbox_update',id:editing,mailbox:mailbox},function(){say(msg,true,'Saved. Use Test to check the login.');reset()})}
      else run('Adding...',{action:'mailbox_add',mailbox:mailbox},function(){say(msg,true,'Mailbox added. Use Test to check the login, then Run sync now.');reset()});
    });
  })();
  var N=${safeJson({ config: n.config, saved: n.saved, hooks: n.hooks, nextDigestAt: n.nextDigestAt, canSave: n.canSaveWebhook })};
  var FOPS=${safeJson(FILTER_OPS)},FTAGS=${safeJson(vm.tags ?? [])};
  (function(){
    var $=function(id){return document.getElementById(id)};
    var DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var c=N.config,d=c.digest;
    var browserTz=(Intl.DateTimeFormat().resolvedOptions().timeZone)||'UTC';
    var tz=N.saved?d.timezone:browserTz;
    DAYS.forEach(function(n,i){var o=document.createElement('option');o.value=i;o.textContent=n;$('d-weekday').appendChild(o)});
    for(var h=0;h<24;h++){var o=document.createElement('option');o.value=h;o.textContent=(h%12||12)+':00 '+(h<12?'AM':'PM');$('d-hour').appendChild(o)}
    var zones=[];try{zones=Intl.supportedValuesOf('timeZone')}catch(e){}
    if(zones.indexOf('UTC')<0)zones.unshift('UTC');if(zones.indexOf(tz)<0)zones.unshift(tz);
    zones.forEach(function(z){var o=document.createElement('option');o.value=z;o.textContent=z.replace(/_/g,' ');$('d-tz').appendChild(o)});
    $('r-nfs').checked=c.rules.newFailingSender.on;$('r-nfs-min').value=c.rules.newFailingSender.minMessages;
    $('r-drop').checked=c.rules.passRateDrop.on;$('r-drop-pts').value=c.rules.passRateDrop.points;$('r-drop-min').value=c.rules.passRateDrop.minMessages;
    $('r-pol').checked=c.rules.policyChange.on;
    $('r-sync').checked=c.rules.syncHealth.on;$('r-sync-min').value=c.rules.syncHealth.staleMinutes;
    $('d-mode').value=d.mode;$('d-every').value=d.everyDays;$('d-weekday').value=d.weekday;$('d-dom').value=d.dayOfMonth;$('d-hour').value=d.hour;$('d-tz').value=tz;

    function showFields(){
      var m=$('d-mode').value;
      $('d-every-wrap').hidden=m!=='days';$('d-weekday-wrap').hidden=m!=='weekly';$('d-dom-wrap').hidden=m!=='monthly';
      $('d-time-wrap').hidden=m==='off';
    }
    function showNext(at){
      var el=$('d-next');
      if($('d-mode').value==='off'){el.textContent='The digest is off.';return}
      if(!N.hooks.some(function(h){return h.digest})){el.textContent='Add a webhook that receives the digest to start sending it.';return}
      if(!at){el.textContent='';return}
      try{el.textContent='Next digest: '+new Date(at*1000).toLocaleString('en-US',{timeZone:$('d-tz').value,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})+'. It is sent within 5 minutes of that time.'}catch(e){el.textContent=''}
    }
    function rulesNote(){var n=['r-nfs','r-drop','r-pol','r-sync'].filter(function(i){return $(i).checked}).length;$('rules-note').textContent=n+' of 4 on'}
    ['r-nfs','r-drop','r-pol','r-sync'].forEach(function(i){$(i).addEventListener('change',rulesNote)});rulesNote();
    $('d-mode').addEventListener('change',function(){showFields();showNext(null)});
    showFields();showNext(N.nextDigestAt);

    function config(){
      return{rules:{
        newFailingSender:{on:$('r-nfs').checked,minMessages:$('r-nfs-min').value},
        passRateDrop:{on:$('r-drop').checked,points:$('r-drop-pts').value,minMessages:$('r-drop-min').value},
        policyChange:{on:$('r-pol').checked},
        syncHealth:{on:$('r-sync').checked,staleMinutes:$('r-sync-min').value}},
        digest:{mode:$('d-mode').value,everyDays:$('d-every').value,weekday:$('d-weekday').value,dayOfMonth:$('d-dom').value,hour:$('d-hour').value,timezone:$('d-tz').value}};
    }
    var msg=$('n-msg'),out=$('n-preview-out'),box=$('hooks');
    function rel(at){var s=Math.max(0,Date.now()/1000-at);if(s<90)return 'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<172800)return Math.round(s/3600)+' hours ago';return Math.round(s/86400)+' days ago'}
    function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
    function check(cls,label,on,disabled){var l=el('label','check-inline');var i=document.createElement('input');i.type='checkbox';i.className=cls;i.checked=on;i.disabled=!!disabled;l.appendChild(i);l.appendChild(document.createTextNode(' '+label));return l}
    function renderHooks(){
      box.textContent='';
      $('hooks-empty').hidden=N.hooks.length>0;setBadge('notifications',N.hooks.length);
      N.hooks.forEach(function(h){
        var secret=h.source==='secret';
        var row=el('div','hook');row.setAttribute('data-id',h.id);
        var main=el('div','hook-main');
        var name=el('input','input hook-name');name.type='text';name.maxLength=40;name.value=h.name;name.placeholder='Unnamed webhook';name.setAttribute('aria-label','Nickname');name.disabled=secret;
        main.appendChild(name);main.appendChild(el('code','hook-url',h.masked));
        main.appendChild(el('span','pill secret',h.type==='json'?'JSON':'Slack'));
        if(h.type==='json'&&h.signed)main.appendChild(el('span','pill saved','signed'));
        if(secret)main.appendChild(el('span','pill secret','Worker secret'));
        row.appendChild(main);
        var act=el('div','hook-actions');
        var t=el('button','btn secondary','Test');t.type='button';t.setAttribute('data-act','test');act.appendChild(t);
        if(h.type==='json'&&!secret){var k=el('button','btn secondary',h.signed?'Change secret':'Set secret');k.type='button';k.setAttribute('data-act','secret');act.appendChild(k)}
        if(!secret){var r=el('button','btn secondary danger','Remove');r.type='button';r.setAttribute('data-act','remove');act.appendChild(r)}
        row.appendChild(act);
        var routes=el('div','hook-routes');routes.appendChild(check('h-a','Alerts',h.alerts,secret));routes.appendChild(check('h-d','Digest',h.digest,secret));
        row.appendChild(routes);
        var sc=el('div','hook-scope');sc.appendChild(document.createTextNode('Domains: '));
        sc.appendChild(el('span','scope-text',h.filterText?'only where '+h.filterText:'all'));
        if(!secret){var fb=el('button','link-btn',h.filterText?'Change':'Choose domains');fb.type='button';fb.setAttribute('data-act','filter');sc.appendChild(fb)}
        row.appendChild(sc);
        if(editingFilter===h.id)row.appendChild(filterEditor(h));
        var st=el('div','hook-status');
        if(h.result){var ok=el('span',h.result.ok?'v-good':'v-bad',h.result.ok?'OK':'Failed');st.appendChild(document.createTextNode('Last delivery: '));st.appendChild(ok);st.appendChild(document.createTextNode(' '+rel(h.result.at)+' \u00b7 '+h.result.detail))}
        else st.textContent='Nothing sent to this webhook yet.';
        row.appendChild(st);
        box.appendChild(row);
      });
    }
    var editingFilter=null,editBuilder=null;
    function filterEditor(h){
      var wrap=el('div','hook-filter');var holder=el('div');wrap.appendChild(holder);
      editBuilder=DCFilter.mount(holder,{ops:FOPS,fields:['tag','domain','policy'],tags:FTAGS.map(function(t){return {tag:t}}),initial:h.filter});
      if(!h.filter)holder.querySelector('.fb-add').click();
      var r=el('div','row');
      var s=el('button','btn','Save');s.type='button';s.setAttribute('data-act','filter-save');r.appendChild(s);
      var c=el('button','btn secondary','Cancel');c.type='button';c.setAttribute('data-act','filter-cancel');r.appendChild(c);
      if(h.filter){var x=el('button','btn secondary danger','Send everything');x.type='button';x.setAttribute('data-act','filter-clear');r.appendChild(x)}
      wrap.appendChild(r);return wrap;
    }
    renderHooks();
    function adopt(t){var r=JSON.parse(t);N.hooks=r.hooks;N.nextDigestAt=r.nextDigestAt;renderHooks();showNext(r.nextDigestAt)}
    function busy(b){
      ['n-save','n-digest','n-preview'].forEach(function(i){$(i).disabled=b});
      if(N.canSave)$('h-add').disabled=b;
      box.querySelectorAll('button,input').forEach(function(e){
        if(b){e.setAttribute('data-was',e.disabled?'1':'0');e.disabled=true}
        else if(e.hasAttribute('data-was'))e.disabled=e.getAttribute('data-was')==='1';
      });
    }
    function run(label,body,done,refresh){
      busy(true);msg.className='msg';msg.textContent=label;
      post(body).then(function(t){done(t)})
        .catch(function(err){say(msg,false,err.message);if(refresh)return post({action:'notify_state'}).then(adopt).catch(function(){})})
        .finally(function(){busy(false)});
    }
    function update(id,patch,what){
      var body={action:'webhook_update',id:id};for(var k in patch)body[k]=patch[k];
      run('Saving...',body,function(t){adopt(t);say(msg,true,what)});
    }
    box.addEventListener('change',function(e){
      var row=e.target.closest('.hook');if(!row)return;var id=row.getAttribute('data-id');
      if(e.target.classList.contains('hook-name'))update(id,{name:e.target.value},'Nickname saved.');
      else if(e.target.classList.contains('h-a'))update(id,{alerts:e.target.checked},e.target.checked?'This webhook will receive alerts.':'This webhook will no longer receive alerts.');
      else if(e.target.classList.contains('h-d'))update(id,{digest:e.target.checked},e.target.checked?'This webhook will receive the digest.':'This webhook will no longer receive the digest.');
    });
    box.addEventListener('click',function(e){
      var b=e.target.closest('button[data-act]');if(!b)return;
      var row=b.closest('.hook'),id=row.getAttribute('data-id');
      var h=N.hooks.filter(function(x){return x.id===id})[0],label=(h&&h.name)||(h&&h.masked)||'this webhook';
      var act=b.getAttribute('data-act');
      if(act==='filter'){editingFilter=editingFilter===id?null:id;renderHooks();return}
      if(act==='filter-cancel'){editingFilter=null;editBuilder=null;renderHooks();return}
      if(act==='filter-clear'){update(id,{filter:null},label+' will now receive every domain.');editingFilter=null;return}
      if(act==='filter-save'){
        var err=editBuilder.validate();if(err){say(msg,false,err);return}
        var w=editBuilder.get();
        if(!w){say(msg,false,'Add a condition, or choose Send everything.');return}
        update(id,{filter:w},label+' will only receive the domains that match.');editingFilter=null;return;
      }
      if(b.getAttribute('data-act')==='secret'){
        var v=prompt('Signing secret for '+label+'. Requests are signed with HMAC-SHA256 using this secret. Leave empty to turn signing off.','');
        if(v===null)return;
        update(id,{secret:v},v?'Signing secret saved.':'Signing turned off.');return;
      }
      if(b.getAttribute('data-act')==='test'){
        run('Sending a test message...',{action:'webhook_test',id:id},function(t){adopt(t);say(msg,true,'Test message sent to '+label+'.')},true);
      }else{
        if(!confirm('Remove '+label+'? It will stop receiving alerts and digests.'))return;
        run('Removing...',{action:'webhook_remove',id:id},function(t){adopt(t);say(msg,true,'Removed '+label+'.')});
      }
    });
    $('hook-add').addEventListener('submit',function(e){
      e.preventDefault();var url=$('h-url').value.trim();
      if(!url){say(msg,false,'Paste the webhook URL.');return}
      var filter=null;
      if(addBuilder){var err=addBuilder.validate();if(err){say(msg,false,err);return}filter=addBuilder.get()}
      run('Adding...',{action:'webhook_add',url:url,name:$('h-name').value,type:$('h-type').value,secret:$('h-secret').value,alerts:$('h-alerts').checked,digest:$('h-digest').checked,filter:filter},function(t){
        adopt(t);$('h-url').value='';$('h-name').value='';$('h-secret').value='';
        addBuilder=null;$('h-filter-builder').textContent='';$('h-filter-fold').open=false;$('h-filter-note').textContent='every domain';
        say(msg,true,'Webhook added. Use Test to check that a message arrives.');
      });
    });
    var addBuilder=null;
    $('h-filter-fold').addEventListener('toggle',function(){
      if(!$('h-filter-fold').open||addBuilder)return;
      addBuilder=DCFilter.mount($('h-filter-builder'),{ops:FOPS,fields:['tag','domain','policy'],tags:FTAGS.map(function(t){return {tag:t}}),initial:null,
        onChange:function(){var n=addBuilder?addBuilder.count():0;$('h-filter-note').textContent=n?n+' condition'+(n===1?'':'s'):'every domain'}});
      $('h-filter-builder').querySelector('.fb-add').click();
    });
    $('h-type').addEventListener('change',function(){
      var j=$('h-type').value==='json';
      $('h-secret-row').hidden=!j;
      $('h-url').placeholder=j?'https://example.com/your/endpoint':'https://hooks.slack.com/services/...';
    });
    $('n-save').addEventListener('click',function(){
      run('Saving...',{action:'notify_save',config:config()},function(t){adopt(t);say(msg,true,'Saved.')});
    });
    $('n-digest').addEventListener('click',function(){
      run('Building and sending the digest...',{action:'digest_now'},function(t){adopt(t);say(msg,true,'Digest sent. Check your channel.')},true);
    });
    $('n-preview').addEventListener('click',function(){
      run('Checking the last 7 days...',{action:'notify_preview'},function(t){
        var r=JSON.parse(t);out.hidden=false;
        out.textContent=r.count?r.text.join('\\n'):'Nothing would have been reported in the last 7 days.';
        say(msg,true,'Preview only. Nothing was sent. Shows rules as saved: save first if you changed them.');
      });
    });
  })();`;

  return layout({
    signedIn: vm.signedIn,
    title: "Admin",
    subtitle: "Setup, mailboxes, notifications and visibility. Requires the admin login.",
    active: "admin",
    filterBuilder: true,
    url,
    body: adminBody,
    scripts,
    css: CSS,
  });
}
