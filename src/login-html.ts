// The sign-in page: a small box over the app's own frame (sidebar, header,
// empty cards), dimmed and blurred. The frame carries no data, so nothing
// private is behind the blur. A plain form, so it works without JavaScript.

import { layout, escapeHtml } from "./shared-ui";

const CSS = `
.sk-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
.sk-block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.sk-kpi { height: 92px; } .sk-wide { height: 280px; margin-bottom: 20px; } .sk-table { height: 220px; }
@media (max-width: 900px) { .sk-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.login-overlay {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(6, 8, 18, 0.3); -webkit-backdrop-filter: blur(5px); backdrop-filter: blur(5px);
}
.login-card { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 14px; padding: 26px 26px 22px; box-shadow: 0 24px 70px rgba(0,0,0,0.45); }
.login-title { font-weight: 700; font-size: 18px; margin: 0 0 2px; }
.login-sub { color: var(--muted); margin-bottom: 8px; }
.login-card label { display: block; font-weight: 600; font-size: 12.5px; margin: 14px 0 6px; }
.login-card .btn { width: 100%; margin-top: 20px; padding: 10px 18px; }
.login-err { margin-top: 12px; }
`;

const SCRIPT = `(function(){
  var m=document.getElementById('login-modal');
  document.body.appendChild(m);
  var s=document.querySelector('.shell');if(s){s.inert=true;s.setAttribute('aria-hidden','true')}
  var k=document.querySelector('.skip');if(k)k.remove();
  var u=document.getElementById('u');if(u)u.focus();
})();`;

export function renderLogin(opts: { url: URL; next: string; error?: string; locked?: boolean; nonce: string }): string {
  const body = `
<div class="sk-row"><div class="sk-block sk-kpi"></div><div class="sk-block sk-kpi"></div><div class="sk-block sk-kpi"></div><div class="sk-block sk-kpi"></div></div>
<div class="sk-block sk-wide"></div>
<div class="sk-block sk-table"></div>
<div class="login-overlay" id="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-h">
  <form class="login-card" method="post" action="/login">
    <h2 class="login-title" id="login-h">Sign in</h2>
    <div class="login-sub">Sign in to continue.</div>
    ${opts.error ? `<div class="warn-box login-err" role="alert">${escapeHtml(opts.error)}</div>` : ""}
    <label for="u">Username</label>
    <input class="input" id="u" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <label for="p">Password</label>
    <input class="input" id="p" name="password" type="password" autocomplete="current-password" required>
    <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
    <button class="btn" type="submit"${opts.locked ? " disabled" : ""}>Sign in</button>
  </form>
</div>`;
  return layout({ title: "Sign in", active: null, url: opts.url, nonce: opts.nonce, body, css: CSS, scripts: SCRIPT });
}
