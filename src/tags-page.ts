// The Tags page: a place in the sidebar next to Domains, for putting tags on domains, importing
// and exporting them, and writing the automatic rules. It changes data, so it always asks for
// the admin login, like Admin and the exports.

import { layout, safeJson } from "./shared-ui";
import { FILTER_OPS } from "./filter-builder-ui";
import { TAGS_JS, tagsPanels, type TagsView } from "./tags-ui";

const CSS = `
.field { margin-bottom: 18px; }
.field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.field .input { max-width: 440px; }
.msg { margin-top: 12px; font-size: 13.5px; min-height: 1.2em; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
.row .input { width: auto; max-width: 100%; }
.btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
pre.preview { margin: 12px 0 0; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
`;

const SCRIPT = (view: TagsView) => `
(function(){
  window.post=function(body){return fetch('/admin',{method:'POST',headers:{'content-type':'application/json','x-settings-request':'1'},body:JSON.stringify(body)}).then(function(r){return r.text().then(function(t){
    if(r.status===401){location.href='/login?next=/tags';throw new Error('Your session ended. Redirecting to the sign-in page...')}
    if(!r.ok){var m;try{m=JSON.parse(t).error}catch(e){m=t}throw new Error((m||'That did not work.').trim())}
    return t})})};
  window.say=function(el,ok,t){el.className='msg '+(ok?'ok':'err');el.textContent=t};
})();
var TG=${safeJson(view)};var TG_OPS=${safeJson(FILTER_OPS)};
${TAGS_JS}
`;

export function renderTagsPage(view: TagsView, url: URL): string {
  return layout({
    title: "Tags",
    subtitle: "Label domains to filter every page and to send alerts to the right people",
    active: "tags",
    url,
    signedIn: true,
    filterBuilder: true,
    css: CSS,
    body: `<div class="stack tags-page">${tagsPanels(view)}</div>`,
    scripts: SCRIPT(view),
  });
}
