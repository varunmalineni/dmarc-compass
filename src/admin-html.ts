import { escapeHtml, navHtml, htmlHead, fmtDate, fmtNumber, BRAND } from "./shared-ui";
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

function check(ok: boolean, label: string, detail: string): string {
  return `
    <li class="check ${ok ? "ok" : "todo"}">
      <span class="check-icon">${ok ? "&#10003;" : "!"}</span>
      <div><div class="check-label">${label}</div><div class="check-detail">${detail}</div></div>
    </li>`;
}

export function renderAdmin(vm: AdminViewModel): string {
  const s = vm.status;
  const sourceLabel = (key: ConfigKey) =>
    vm.overridden.has(key)
      ? '<span class="pill-override">saved here</span>'
      : '<span class="pill-default">from Worker secret</span>';

  const lastSyncDetail = s.lastSync
    ? `${s.lastSync.ok ? "Succeeded" : "Failed"} on ${fmtDate(s.lastSync.at)} &middot; ${escapeHtml(s.lastSync.summary)}`
    : "Has not run yet. The scheduled sync runs every 15 minutes, or run one now.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
${htmlHead(`Admin · ${BRAND}`)}
<style>
  .form-row { margin-bottom: 18px; }
  .form-row label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .form-row input[type=text], .form-row input[type=password] {
    width: 100%; max-width: 420px; padding: 9px 12px; border: 1px solid var(--border);
    border-radius: 9px; font-size: 14px; font-family: inherit;
  }
  .form-row input:focus { outline: 2px solid var(--accent-light); border-color: var(--accent); }
  .form-row input:disabled { background: #f6f7fb; cursor: not-allowed; }
  .pill-override, .pill-default {
    font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; margin-left: 8px;
  }
  .pill-override { background: var(--accent-light); color: var(--accent); }
  .pill-default { background: #f1f2f6; color: var(--muted); }
  .btn {
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: white; border: none;
    padding: 10px 20px; border-radius: 9px; font-size: 14px; font-weight: 700; cursor: pointer;
    box-shadow: 0 4px 12px rgba(67, 56, 202, 0.28);
  }
  .btn.secondary { background: white; color: var(--accent); border: 1px solid var(--border); box-shadow: none; }
  .btn:disabled { opacity: 0.6; cursor: wait; }
  .status-msg { margin-top: 12px; font-size: 13.5px; }
  .status-msg.ok { color: var(--good); }
  .status-msg.err { color: var(--bad); }
  ul.checks { list-style: none; margin: 0 0 18px; padding: 0; }
  .check { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f1f2f6; }
  .check:last-child { border-bottom: none; }
  .check-icon {
    width: 22px; height: 22px; flex: none; border-radius: 50%; color: white; font-weight: 800; font-size: 12px;
    display: flex; align-items: center; justify-content: center; margin-top: 1px;
  }
  .check.ok .check-icon { background: #22c55e; }
  .check.todo .check-icon { background: #f59e0b; }
  .check-label { font-weight: 600; font-size: 14px; }
  .check-detail { font-size: 12.5px; color: var(--muted); margin-top: 2px; line-height: 1.5; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  .switch { position: relative; width: 46px; height: 26px; flex: none; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; inset: 0; background: #d1d5db; border-radius: 999px; cursor: pointer; transition: background 0.15s;
  }
  .slider::before {
    content: ""; position: absolute; width: 20px; height: 20px; left: 3px; top: 3px; background: white;
    border-radius: 50%; transition: transform 0.15s; box-shadow: 0 1px 3px rgba(0,0,0,0.25);
  }
  .switch input:checked + .slider { background: var(--accent); }
  .switch input:checked + .slider::before { transform: translateX(20px); }
  .switch input:disabled + .slider { opacity: 0.6; cursor: wait; }
  .warn-box {
    background: var(--warn-bg); border: 1px solid #fde68a; border-radius: 10px; padding: 12px 14px;
    font-size: 13px; line-height: 1.55; margin-bottom: 16px; color: #78350f;
  }
  .warn-box code { background: #fef3c7; }
</style>
</head>
<body>
<header>
  <div class="eyebrow">${BRAND} &middot; Admin</div>
  <h1>Admin</h1>
  ${navHtml(null, null)}
</header>
<main>
  <div class="card">
    <h2>Setup status</h2>
    <ul class="checks">
      ${check(true, "Database connected", `Schema v${s.schemaVersion} of v${s.latestSchemaVersion}. Tables are created and upgraded automatically.`)}
      ${check(
        s.encryptionKeyConfigured,
        "Config encryption key",
        s.encryptionKeyConfigured
          ? "Mailbox credentials saved here are encrypted before they are stored."
          : "Missing. Without it, credentials can't be saved from this page. Run <code>openssl rand -base64 32 | npx wrangler secret put CONFIG_ENCRYPTION_KEY</code>.",
      )}
      ${check(
        s.imapConfigured,
        "Mailbox connected",
        s.imapConfigured
          ? "Host, user and password are set."
          : "Not configured yet. Fill in the mailbox that receives your DMARC reports below.",
      )}
      ${check(Boolean(s.lastSync?.ok), "Last sync", lastSyncDetail)}
      ${check(
        s.reports > 0,
        "Data",
        s.reports > 0
          ? `${fmtNumber(s.reports)} DMARC reports across ${fmtNumber(s.domains)} domain${s.domains === 1 ? "" : "s"}, ${fmtNumber(s.tlsReports)} TLS reports.`
          : "No reports ingested yet. They appear after the first successful sync.",
      )}
    </ul>
    <button class="btn secondary" id="sync-btn" type="button">Run sync now</button>
    <div class="status-msg" id="sync-status"></div>
  </div>

  <div class="card">
    <h2>Dashboard visibility</h2>
    <div class="toggle-row">
      <div>
        <div style="font-weight:600;font-size:14px">Allow anyone with the link to view the dashboard</div>
        <div class="form-hint" style="margin-top:4px">
          Off (default): every page asks for the admin login. On: the read-only dashboard pages
          (Overview, Domains, Reports, TLS, Sender Map) are public. This page and the Classic
          dashboard always require the admin login. Public pages show your sending IPs and pass
          rates, so only turn this on if that is acceptable.
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" id="public-toggle" ${vm.publicDashboard ? "checked" : ""} />
        <span class="slider"></span>
      </label>
    </div>
    <div class="status-msg" id="visibility-status"></div>
  </div>

  <div class="card">
    <h2>Mailbox (IMAP)</h2>
    <p class="form-hint" style="margin-top:-8px;margin-bottom:18px">
      The mailbox that receives your DMARC <code>rua=</code> reports. Leave a field blank to keep
      its current value. Saving restarts the container, so changes apply within about a minute.
    </p>
    ${
      s.encryptionKeyConfigured
        ? ""
        : `<div class="warn-box">Saving is disabled until the <code>CONFIG_ENCRYPTION_KEY</code> secret is set (see Setup status above).</div>`
    }
    <form id="settings-form">
      <div class="form-row">
        <label>IMAP host ${sourceLabel("IMAP_HOST")}</label>
        <input type="text" name="imap_host" value="${escapeHtml(vm.imapHost)}" placeholder="imap.example.com" ${s.encryptionKeyConfigured ? "" : "disabled"} />
      </div>
      <div class="form-row">
        <label>IMAP user ${sourceLabel("IMAP_USER")}</label>
        <input type="text" name="imap_user" value="${escapeHtml(vm.imapUser)}" placeholder="dmarc@example.com" ${s.encryptionKeyConfigured ? "" : "disabled"} />
      </div>
      <div class="form-row">
        <label>Folder ${sourceLabel("IMAP_FOLDER")}</label>
        <input type="text" name="imap_folder" value="${escapeHtml(vm.imapFolder)}" placeholder="INBOX" ${s.encryptionKeyConfigured ? "" : "disabled"} />
        <div class="form-hint">Folder names are case-sensitive.</div>
      </div>
      <div class="form-row">
        <label>Password ${sourceLabel("IMAP_PASSWORD")}</label>
        <input type="password" name="imap_password" placeholder="Leave blank to keep current value" autocomplete="new-password" ${s.encryptionKeyConfigured ? "" : "disabled"} />
        <div class="form-hint">
          ${vm.passwordUpdatedAt ? `Last changed here on ${fmtDate(vm.passwordUpdatedAt)}. ` : ""}Never shown back in the browser. Use an app-specific password where your provider offers one.
        </div>
      </div>
      <button class="btn" id="save-btn" type="submit" ${s.encryptionKeyConfigured ? "" : "disabled"}>Save &amp; restart container</button>
      <div class="status-msg" id="status"></div>
    </form>
  </div>
</main>
<script>
  // A custom header is required on every write. Cross-site <form> posts can't
  // set one without a CORS preflight (which this app never allows), so this is
  // what keeps these endpoints safe from CSRF alongside Basic Auth.
  async function post(body) {
    const res = await fetch('/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-settings-request': '1' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.text();
  }

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('save-btn');
    const status = document.getElementById('status');
    btn.disabled = true;
    status.className = 'status-msg';
    status.textContent = 'Saving...';
    const f = new FormData(e.target);
    try {
      await post({
        imap_host: f.get('imap_host') || '',
        imap_user: f.get('imap_user') || '',
        imap_folder: f.get('imap_folder') || '',
        imap_password: f.get('imap_password') || '',
      });
      status.className = 'status-msg ok';
      status.textContent = 'Saved. The container is restarting - give it about a minute, then run a sync.';
    } catch (err) {
      status.className = 'status-msg err';
      status.textContent = 'Failed to save: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('public-toggle').addEventListener('change', async (e) => {
    const toggle = e.target;
    const status = document.getElementById('visibility-status');
    toggle.disabled = true;
    status.className = 'status-msg';
    status.textContent = 'Saving...';
    try {
      await post({ public_dashboard: toggle.checked });
      status.className = 'status-msg ok';
      status.textContent = toggle.checked ? 'Dashboard is now public.' : 'Dashboard now requires login.';
    } catch (err) {
      toggle.checked = !toggle.checked;
      status.className = 'status-msg err';
      status.textContent = 'Failed to save: ' + err.message;
    } finally {
      toggle.disabled = false;
    }
  });

  document.getElementById('sync-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    const status = document.getElementById('sync-status');
    btn.disabled = true;
    status.className = 'status-msg';
    status.textContent = 'Syncing - the first run can take a minute while the container starts...';
    try {
      const out = JSON.parse(await post({ action: 'sync' }));
      status.className = 'status-msg ok';
      status.textContent =
        'Done: ' + out.newReports + ' new DMARC reports, ' + out.newTlsReports + ' new TLS reports. Reload to refresh the status above.';
    } catch (err) {
      status.className = 'status-msg err';
      status.textContent = 'Sync failed: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
