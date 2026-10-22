import { escapeHtml, fmtDate, fmtNumber, layout, panel, relTime } from "./shared-ui";
import type { ConfigKey } from "./settings-data";
import type { LastSync } from "./app-settings";

export interface AdminViewModel {
  imapHost: string;
  imapUser: string;
  imapFolder: string;
  overridden: Set<ConfigKey>;
  passwordUpdatedAt: number | null;
  publicDashboard: boolean;
  status: {
    schemaVersion: number;
    latestSchemaVersion: number;
    reports: number;
    tlsReports: number;
    domains: number;
    encryptionKeyConfigured: boolean;
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
main { max-width: 860px; margin: 0 auto; }
`;

function check(ok: boolean, label: string, detail: string): string {
  return `<li class="check ${ok ? "ok" : "todo"}"><span class="check-icon">${ok ? "&#10003;" : "!"}</span><div><div class="check-label">${label}</div><div class="check-detail">${detail}</div></div></li>`;
}

export function renderAdmin(vm: AdminViewModel, url: URL): string {
  const s = vm.status;
  const locked = s.encryptionKeyConfigured ? "" : "disabled";
  const source = (key: ConfigKey) =>
    vm.overridden.has(key) ? '<span class="pill saved">saved here</span>' : '<span class="pill secret">from Worker secret</span>';

  const lastSync = s.lastSync
    ? `${s.lastSync.ok ? "Succeeded" : "Failed"} ${relTime(s.lastSync.at)} &middot; ${escapeHtml(s.lastSync.summary)}`
    : "Has not run yet. The scheduled sync runs every 15 minutes, or run one now.";

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

  const visibility = panel(
    "Dashboard visibility",
    `<div class="toggle-row">
      <div>
        <div style="font-weight:600" id="vis-label">Allow anyone with the link to view the dashboard</div>
        <div class="hint" style="margin-top:4px">
          Off (default): every page asks for the admin login. On: the read-only pages (Overview, Domains, reports, TLS, map) are public.
          This page and the Classic dashboard always require login. Public pages show your sending IPs and pass rates, so enable this only if that is acceptable.
        </div>
      </div>
      <label class="switch"><input type="checkbox" id="public-toggle" aria-labelledby="vis-label" ${vm.publicDashboard ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="msg" id="vis-msg" role="status"></div>`,
  );

  const imap = panel(
    "Mailbox (IMAP)",
    `<p class="hint" style="margin-top:0">The mailbox that receives your DMARC <code>rua=</code> reports. Leave a field blank to keep its current value. Saving restarts the container, so changes apply within about a minute.</p>
    ${s.encryptionKeyConfigured ? "" : '<div class="warn-box">Saving is disabled until the <code>CONFIG_ENCRYPTION_KEY</code> secret is set (see Setup status).</div>'}
    <form id="imap-form">
      <div class="field"><label for="f-host">IMAP host ${source("IMAP_HOST")}</label><input class="input" id="f-host" type="text" name="imap_host" value="${escapeHtml(vm.imapHost)}" placeholder="imap.example.com" ${locked}></div>
      <div class="field"><label for="f-user">IMAP user ${source("IMAP_USER")}</label><input class="input" id="f-user" type="text" name="imap_user" value="${escapeHtml(vm.imapUser)}" placeholder="dmarc@example.com" ${locked}></div>
      <div class="field"><label for="f-folder">Folder ${source("IMAP_FOLDER")}</label><input class="input" id="f-folder" type="text" name="imap_folder" value="${escapeHtml(vm.imapFolder)}" placeholder="INBOX" ${locked}><div class="hint">Folder names are case-sensitive.</div></div>
      <div class="field"><label for="f-pass">Password ${source("IMAP_PASSWORD")}</label><input class="input" id="f-pass" type="password" name="imap_password" placeholder="Leave blank to keep current value" autocomplete="new-password" ${locked}>
        <div class="hint">${vm.passwordUpdatedAt ? `Last changed here on ${fmtDate(vm.passwordUpdatedAt)}. ` : ""}Never shown back in the browser. Use an app-specific password where your provider offers one.</div></div>
      <button class="btn" id="save-btn" type="submit" ${locked}>Save and restart container</button>
      <div class="msg" id="save-msg" role="status"></div>
    </form>`,
  );

  const scripts = `
  // Every write carries a custom header. A cross-site <form> can't set one
  // without a CORS preflight (which this app never allows), which is what
  // protects these endpoints from CSRF alongside Basic Auth.
  function post(body){return fetch('/admin',{method:'POST',headers:{'content-type':'application/json','x-settings-request':'1'},body:JSON.stringify(body)}).then(function(r){return r.text().then(function(t){if(!r.ok)throw new Error(t);return t})})}
  function say(el,ok,t){el.className='msg '+(ok?'ok':'err');el.textContent=t}
  document.getElementById('imap-form').addEventListener('submit',function(e){
    e.preventDefault();var b=document.getElementById('save-btn'),m=document.getElementById('save-msg'),f=new FormData(e.target);
    b.disabled=true;m.className='msg';m.textContent='Saving...';
    post({imap_host:f.get('imap_host')||'',imap_user:f.get('imap_user')||'',imap_folder:f.get('imap_folder')||'',imap_password:f.get('imap_password')||''})
      .then(function(){say(m,true,'Saved. The container is restarting; give it about a minute, then run a sync.')})
      .catch(function(err){say(m,false,'Failed to save: '+err.message)}).finally(function(){b.disabled=false});
  });
  document.getElementById('public-toggle').addEventListener('change',function(e){
    var t=e.target,m=document.getElementById('vis-msg');t.disabled=true;m.className='msg';m.textContent='Saving...';
    post({public_dashboard:t.checked})
      .then(function(){say(m,true,t.checked?'Dashboard is now public.':'Dashboard now requires login.')})
      .catch(function(err){t.checked=!t.checked;say(m,false,'Failed to save: '+err.message)}).finally(function(){t.disabled=false});
  });
  document.getElementById('sync-btn').addEventListener('click',function(e){
    var b=e.target,m=document.getElementById('sync-msg');b.disabled=true;m.className='msg';
    m.textContent='Syncing. The first run can take a minute while the container starts...';
    post({action:'sync'}).then(function(t){var o=JSON.parse(t);say(m,true,'Done: '+o.newReports+' new DMARC reports, '+o.newTlsReports+' new TLS reports. Reload to refresh the status above.')})
      .catch(function(err){say(m,false,'Sync failed: '+err.message)}).finally(function(){b.disabled=false});
  });`;

  return layout({
    title: "Admin",
    subtitle: "Setup, mailbox and visibility. Requires the admin login.",
    active: null,
    url,
    body: `${status}${visibility}${imap}`,
    scripts,
    css: CSS,
  });
}
