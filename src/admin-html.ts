import { escapeHtml, fmtDate, fmtNumber, layout, panel, relTime, safeJson } from "./shared-ui";
import type { NotifyView } from "./notify";
import type { ConfigKey } from "./settings-data";
import type { LastSync } from "./app-settings";

export interface AdminViewModel {
  notify: NotifyView;
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
          This page always requires login. Public pages show your sending IPs and pass rates, so enable this only if that is acceptable.
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


  const n = vm.notify;
  const notifications = panel(
    "Notifications",
    `<p class="hint" style="margin-top:0">Alerts and a periodic digest, delivered to Slack-compatible incoming webhooks (Slack, Mattermost, and others that accept the same format). Add as many as you like and choose which messages each one receives. Nothing is sent until a webhook is added.</p>
    ${n.canSaveWebhook ? "" : '<div class="warn-box">Saving a webhook here needs the <code>CONFIG_ENCRYPTION_KEY</code> secret (see Setup status). You can instead set a <code>SLACK_WEBHOOK_URL</code> Worker secret, which appears here as a read-only webhook.</div>'}

    <div class="sub-h">Webhooks</div>
    <div class="hooks" id="hooks"></div>
    <div class="hint" id="hooks-empty" hidden>No webhook yet. In Slack, create an Incoming Webhook for the channel you want, then add its URL below.</div>
    <form class="hook-add" id="hook-add" autocomplete="off">
      <div class="hook-add-title">Add a webhook</div>
      <div class="row">
        <label for="h-name" class="sr-only">Nickname</label>
        <input class="input" id="h-name" type="text" maxlength="40" placeholder="Nickname (optional), e.g. #dmarc-alerts" style="width:260px" ${n.canSaveWebhook ? "" : "disabled"}>
        <label for="h-url" class="sr-only">Webhook URL</label>
        <input class="input" id="h-url" type="password" placeholder="https://hooks.slack.com/services/..." style="width:340px" ${n.canSaveWebhook ? "" : "disabled"}>
        <button class="btn" id="h-add" type="submit" ${n.canSaveWebhook ? "" : "disabled"}>Add webhook</button>
      </div>
      <div class="row" style="margin-bottom:0">
        <span class="muted small">Send to this webhook:</span>
        <label class="check-inline"><input type="checkbox" id="h-alerts" checked> Alerts</label>
        <label class="check-inline"><input type="checkbox" id="h-digest" checked> Digest</label>
      </div>
    </form>
    <div class="hint">URLs are stored encrypted and never shown again; only a masked form appears. Up to ${n.hookLimit} webhooks.</div>
    ${n.baseUrlKnown ? "" : '<div class="hint">Messages will link back to this dashboard once you have opened this page once more after adding a webhook.</div>'}

    <div class="sub-h">Alert rules</div>
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
  });
  var N=${safeJson({ config: n.config, saved: n.saved, hooks: n.hooks, nextDigestAt: n.nextDigestAt, canSave: n.canSaveWebhook })};
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
      try{el.textContent='Next digest: '+new Date(at*1000).toLocaleString('en-US',{timeZone:$('d-tz').value,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})+'. It is sent within 15 minutes of that time.'}catch(e){el.textContent=''}
    }
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
      $('hooks-empty').hidden=N.hooks.length>0;
      N.hooks.forEach(function(h){
        var secret=h.source==='secret';
        var row=el('div','hook');row.setAttribute('data-id',h.id);
        var main=el('div','hook-main');
        var name=el('input','input hook-name');name.type='text';name.maxLength=40;name.value=h.name;name.placeholder='Unnamed webhook';name.setAttribute('aria-label','Nickname');name.disabled=secret;
        main.appendChild(name);main.appendChild(el('code','hook-url',h.masked));
        if(secret)main.appendChild(el('span','pill secret','Worker secret'));
        row.appendChild(main);
        var act=el('div','hook-actions');
        var t=el('button','btn secondary','Test');t.type='button';t.setAttribute('data-act','test');act.appendChild(t);
        if(!secret){var r=el('button','btn secondary danger','Remove');r.type='button';r.setAttribute('data-act','remove');act.appendChild(r)}
        row.appendChild(act);
        var routes=el('div','hook-routes');routes.appendChild(check('h-a','Alerts',h.alerts,secret));routes.appendChild(check('h-d','Digest',h.digest,secret));
        row.appendChild(routes);
        var st=el('div','hook-status');
        if(h.result){var ok=el('span',h.result.ok?'v-good':'v-bad',h.result.ok?'OK':'Failed');st.appendChild(document.createTextNode('Last delivery: '));st.appendChild(ok);st.appendChild(document.createTextNode(' '+rel(h.result.at)+' \u00b7 '+h.result.detail))}
        else st.textContent='Nothing sent to this webhook yet.';
        row.appendChild(st);
        box.appendChild(row);
      });
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
      run('Adding...',{action:'webhook_add',url:url,name:$('h-name').value,alerts:$('h-alerts').checked,digest:$('h-digest').checked},function(t){
        adopt(t);$('h-url').value='';$('h-name').value='';say(msg,true,'Webhook added. Use Test to check that a message arrives.');
      });
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
    title: "Admin",
    subtitle: "Setup, mailbox and visibility. Requires the admin login.",
    active: "admin",
    url,
    body: `${status}${visibility}${notifications}${imap}`,
    scripts,
    css: CSS,
  });
}
