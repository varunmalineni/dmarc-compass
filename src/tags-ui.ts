// The Tags page: markup and the script that drives it. The script uses post() and say(),
// which the page defines before it.

import { panel } from "./shared-ui";

export interface TagsView {
  tags: Array<{ tag: string; count: number; byRule: number; color: string; chosen: boolean }>;
  palette: readonly string[];
  rules: Array<{ id: string; tag: string; expr: unknown; text: string; matches: number }>;
  domains: number;
  untagged: number;
  limits: { perDomain: number; tags: number; rules: number };
}

export function tagsPanels(v: TagsView): string {
  const tagsPanel = panel(
    "Tags",
    `<p class="hint" style="margin-top:0">Labels on domains, for filtering every page and for sending alerts to the right people. <b id="tg-summary">${v.domains.toLocaleString("en-US")} domain${v.domains === 1 ? "" : "s"}, ${v.untagged.toLocaleString("en-US")} without a tag.</b></p>
    <div id="tg-tags" class="tags" style="gap:8px"></div>
    <div id="tg-swatches"></div>
    <div class="msg" id="tg-tags-msg" role="status"></div>`,
  );

  const domainsPanel = panel(
    "Domains",
    `<div class="row" style="margin-bottom:10px">
      <input class="input" id="tg-q" type="search" placeholder="Search domains or tags" aria-label="Search domains or tags" style="width:300px;max-width:100%" autocomplete="off">
      <select class="input" id="tg-show" aria-label="Show" style="width:auto"><option value="all">All domains</option><option value="untagged">Without a tag</option></select>
      <select class="input" id="tg-tagsel" aria-label="With tag" style="width:auto"><option value="">Any tag</option></select>
    </div>
    <div class="row" id="tg-bulk" style="margin-bottom:10px">
      <span id="tg-selcount" class="hint" style="min-width:150px">Nothing selected</span>
      <input class="input" id="tg-tagname" list="tg-datalist" placeholder="Tag name" aria-label="Tag name" style="max-width:200px" autocomplete="off" maxlength="32">
      <datalist id="tg-datalist"></datalist>
      <button class="btn" id="tg-add" type="button">Add tag</button>
      <button class="btn secondary" id="tg-remove" type="button">Remove tag</button>
    </div>
    <div id="tg-allmatch" class="hint" hidden></div>
    <div class="table-wrap"><table class="data"><thead><tr><th style="width:34px"><input type="checkbox" id="tg-checkall" aria-label="Select this page"></th><th>Domain</th><th>Tags</th></tr></thead><tbody id="tg-rows"></tbody></table></div>
    <div class="row" style="margin-top:10px;justify-content:space-between"><span class="hint" id="tg-pageinfo"></span><span><button class="btn secondary" id="tg-prev" type="button">Previous</button> <button class="btn secondary" id="tg-next" type="button">Next</button></span></div>
    <div class="msg" id="tg-msg" role="status"></div>
    <p class="hint">Tags with a small gear come from an automatic rule and can't be removed from one domain; change the rule instead. Each domain can have up to ${v.limits.perDomain} tags set by hand, and there can be ${v.limits.tags} different tags.</p>`,
  );

  const rulesPanel = panel(
    "Automatic rules",
    `<p class="hint" style="margin-top:0">A rule gives a tag to every domain whose <b>name</b> matches, including domains that appear later. Nothing is stored per domain, so changing a rule changes every domain at once.</p>
    <div id="tg-rules"></div>
    <details id="tg-ruleform" style="margin-top:10px"><summary><b>Add or edit a rule</b></summary>
      <div class="field" style="margin-top:10px"><label for="tg-rule-tag" style="font-weight:600">Give the tag</label>
        <input class="input" id="tg-rule-tag" list="tg-datalist" maxlength="32" placeholder="emea" autocomplete="off"></div>
      <div style="font-weight:600;margin-bottom:6px">to domains where</div>
      <div id="tg-rule-builder"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn secondary" id="tg-rule-preview" type="button">Preview</button>
        <button class="btn" id="tg-rule-save" type="button">Save rule</button>
        <button class="link-btn" id="tg-rule-cancel" type="button">Cancel</button>
      </div>
      <div class="msg" id="tg-rule-msg" role="status"></div>
    </details>
    <p class="hint">At most ${v.limits.rules} rules. A rule can only look at the domain name.</p>`,
  );

  const ioPanel = panel(
    "Import and export",
    `<p class="hint" style="margin-top:0">One domain per line, then its tags, separated by commas or spaces: <code>example.com, emea, prod</code>. A header line is skipped.</p>
    <textarea class="input" id="tg-import" rows="6" placeholder="example.com, emea, prod&#10;shop.example.de  emea" aria-label="Domains and tags" style="font-family:ui-monospace,monospace"></textarea>
    <div class="row" style="margin-top:8px">
      <label><input type="radio" name="tg-mode" value="add" checked> Add these tags to what the domains have</label>
      <label><input type="radio" name="tg-mode" value="set"> Replace the tags of the listed domains</label>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn secondary" id="tg-import-preview" type="button">Check</button>
      <button class="btn" id="tg-import-apply" type="button" disabled>Import</button>
      <a class="btn secondary" href="/export/tags?format=csv" download>Export tags (CSV)</a>
    </div>
    <div class="msg" id="tg-import-msg" role="status"></div>
    <pre class="preview" id="tg-import-errors" hidden></pre>`,
  );

  return `${tagsPanel}${domainsPanel}${rulesPanel}${ioPanel}`;
}

/** Inline script for the tab. Needs post(), say(), DCFilter and the data in TG / TG_OPS. */
export const TAGS_JS = `
(function(){
  var $=function(id){return document.getElementById(id)};
  if(!$('tg-rows'))return;
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
  function call(body){return post(body).then(function(t){return JSON.parse(t)})}
  var page=1,total=0,pageSize=50,rows=[],selected=new Set(),allMatching=false;

  function colorFor(t){for(var i=0;i<TG.tags.length;i++)if(TG.tags[i].tag===t)return TG.tags[i].color;return 'gray'}
  function tagChip(t,rule){var s=el('span','tag'+(rule?' auto':''),t);s.setAttribute('data-c',colorFor(t));if(rule)s.title='From an automatic rule';return s}
  var openSwatches=null;
  function swatches(t,holder){
    var box=el('div','row');box.style.margin='6px 0 2px';box.appendChild(el('span','hint','Colour of "'+t.tag+'":'));
    TG.palette.forEach(function(c){var b=el('button','swatch');b.type='button';b.setAttribute('data-c',c);b.setAttribute('aria-label',c);b.setAttribute('aria-pressed',String(t.color===c));b.title=c;
      b.addEventListener('click',function(){call({action:'tag_color',tag:t.tag,color:c}).then(refresh).catch(function(e){say($('tg-tags-msg'),false,e.message.trim())})});box.appendChild(b)});
    var a=el('button','link-btn','Pick one for me');a.type='button';a.title='Use the colour least used by other tags';a.addEventListener('click',function(){call({action:'tag_color',tag:t.tag,color:''}).then(refresh).catch(function(e){say($('tg-tags-msg'),false,e.message.trim())})});box.appendChild(a);
    return box;
  }

  function renderTags(){
    var box=$('tg-tags');box.textContent='';
    var dl=$('tg-datalist'),sel=$('tg-tagsel');dl.textContent='';
    var keep=sel.value;sel.textContent='';var any=el('option',null,'Any tag');any.value='';sel.appendChild(any);
    if(!TG.tags.length)box.appendChild(el('span','hint','No tags yet. Select domains below and add one, or create an automatic rule.'));
    TG.tags.forEach(function(t){
      var chip=el('span','tag');chip.setAttribute('data-c',t.color);chip.style.padding='3px 6px 3px 8px';chip.style.display='inline-flex';chip.style.alignItems='center';chip.style.gap='6px';
      var dot=el('button','swatch');dot.type='button';dot.setAttribute('data-c',t.color);dot.setAttribute('aria-label','Change the colour of '+t.tag);dot.title='Change colour';
      dot.addEventListener('click',function(){openSwatches=openSwatches===t.tag?null:t.tag;renderTags()});chip.appendChild(dot);
      var a=el('a',null,t.tag);a.href='/domains?tag='+encodeURIComponent(t.tag);a.style.color='inherit';a.title='Show these domains';chip.appendChild(a);
      chip.appendChild(document.createTextNode(' \\u00b7 '+t.count+(t.byRule?' ('+t.byRule+' by rule)':'')+' '));
      var r=el('button','link-btn','rename');r.type='button';r.style.fontSize='11px';r.style.marginLeft='6px';r.addEventListener('click',function(){
        var to=prompt('New name for "'+t.tag+'" (an existing tag name merges them):',t.tag);if(!to||to===t.tag)return;
        call({action:'tags_rename',from:t.tag,to:to}).then(refresh).catch(function(e){say($('tg-tags-msg'),false,e.message.trim())});
      });chip.appendChild(r);
      var d=el('button','link-btn','delete');d.type='button';d.style.fontSize='11px';d.addEventListener('click',function(){
        if(!confirm('Delete the tag "'+t.tag+'" from all '+t.count+' domains'+(t.byRule?' and remove the rules that give it':'')+'?'))return;
        call({action:'tags_delete',tag:t.tag}).then(refresh).catch(function(e){say($('tg-tags-msg'),false,e.message.trim())});
      });chip.appendChild(d);
      box.appendChild(chip);
      var o=el('option');o.value=t.tag;dl.appendChild(o);
      var s=el('option',null,t.tag);s.value=t.tag;sel.appendChild(s);
    });
    sel.value=keep;
    var picked=TG.tags.filter(function(x){return x.tag===openSwatches})[0];
    var sw=$('tg-swatches');sw.textContent='';if(picked)sw.appendChild(swatches(picked));
    $('tg-summary').textContent=TG.domains.toLocaleString('en-US')+' domain'+(TG.domains===1?'':'s')+', '+TG.untagged.toLocaleString('en-US')+' without a tag.';
  }

  function renderRules(){
    var box=$('tg-rules');box.textContent='';
    if(!TG.rules.length){box.appendChild(el('div','hint','No rules yet.'));return}
    TG.rules.forEach(function(r){
      var row=el('div','row');row.style.margin='6px 0';
      row.appendChild(tagChip(r.tag,false));
      row.appendChild(el('span',null,'for domains where '+r.text));
      row.appendChild(el('span','hint','('+r.matches+' match'+(r.matches===1?'':'es')+')'));
      var e=el('button','link-btn','Edit');e.type='button';e.addEventListener('click',function(){editRule(r)});row.appendChild(e);
      var d=el('button','link-btn','Delete');d.type='button';d.addEventListener('click',function(){
        if(!confirm('Delete this rule? Domains that only had "'+r.tag+'" because of it lose the tag.'))return;
        call({action:'tag_rule_delete',id:r.id}).then(refresh).catch(function(x){say($('tg-rule-msg'),false,x.message.trim())});
      });row.appendChild(d);box.appendChild(row);
    });
  }

  var builder=null,editing=null;
  function mountBuilder(initial){builder=DCFilter.mount($('tg-rule-builder'),{ops:TG_OPS,fields:['domain'],tags:[],initial:initial})}
  function editRule(r){editing=r?r.id:null;$('tg-rule-tag').value=r?r.tag:'';mountBuilder(r?r.expr:null);if(!r)document.querySelector('#tg-rule-builder .fb-add').click();$('tg-ruleform').open=true;$('tg-rule-msg').textContent=''}
  $('tg-ruleform').addEventListener('toggle',function(){if($('tg-ruleform').open&&!builder)editRule(null)});
  $('tg-rule-cancel').addEventListener('click',function(){$('tg-ruleform').open=false;editing=null;builder=null;$('tg-rule-builder').textContent=''});
  function ruleBody(){var err=builder.validate();if(err){say($('tg-rule-msg'),false,err);return null}return {tag:$('tg-rule-tag').value,expr:builder.get(),id:editing}}
  $('tg-rule-preview').addEventListener('click',function(){
    var b=ruleBody();if(!b)return;b.action='tag_rule_preview';
    call(b).then(function(r){say($('tg-rule-msg'),true,r.matches+' domain'+(r.matches===1?'':'s')+' match'+(r.matches?': '+r.sample.join(', ')+(r.matches>r.sample.length?', ...':''):'.'))}).catch(function(e){say($('tg-rule-msg'),false,e.message.trim())});
  });
  $('tg-rule-save').addEventListener('click',function(){
    var b=ruleBody();if(!b)return;b.action='tag_rule_save';
    call(b).then(function(){editing=null;builder=null;$('tg-rule-builder').textContent='';$('tg-ruleform').open=false;say($('tg-rule-msg'),true,'Rule saved.');return refresh()}).catch(function(e){say($('tg-rule-msg'),false,e.message.trim())});
  });

  function selector(){return {q:$('tg-q').value.trim(),untagged:$('tg-show').value==='untagged',tag:$('tg-tagsel').value}}
  function loadRows(){
    var s=selector();
    return call({action:'tags_list',q:s.q,untagged:s.untagged,tag:s.tag,page:page}).then(function(r){
      rows=r.rows;total=r.total;pageSize=r.pageSize;
      var body=$('tg-rows');body.textContent='';
      rows.forEach(function(row){
        var tr=el('tr');var td=el('td');var c=el('input');c.type='checkbox';c.checked=allMatching||selected.has(row.domain);c.setAttribute('aria-label','Select '+row.domain);
        c.addEventListener('change',function(){if(c.checked)selected.add(row.domain);else{selected.delete(row.domain);allMatching=false}counts()});td.appendChild(c);tr.appendChild(td);
        tr.appendChild(el('td',null,row.domain));
        var tt=el('td');if(!row.tags.length)tt.appendChild(el('span','muted','\\u2013'));
        var wrap=el('span','tags');row.tags.forEach(function(t){wrap.appendChild(tagChip(t.tag,t.rule))});tt.appendChild(wrap);tr.appendChild(tt);
        body.appendChild(tr);
      });
      if(!rows.length){var tr=el('tr');var td=el('td','muted','No matching domains.');td.colSpan=3;tr.appendChild(td);body.appendChild(tr)}
      var from=total?(page-1)*pageSize+1:0;
      $('tg-pageinfo').textContent=from+'\\u2013'+Math.min(total,page*pageSize)+' of '+total.toLocaleString('en-US');
      $('tg-prev').disabled=page<=1;$('tg-next').disabled=page*pageSize>=total;
      $('tg-checkall').checked=rows.length>0&&rows.every(function(r){return allMatching||selected.has(r.domain)});
      counts();
    });
  }
  function counts(){
    var n=allMatching?total:selected.size;
    $('tg-selcount').textContent=n?n.toLocaleString('en-US')+' selected':'Nothing selected';
    var box=$('tg-allmatch');
    if(!allMatching&&total>pageSize&&rows.length&&rows.every(function(r){return selected.has(r.domain)})){
      box.hidden=false;box.textContent='';box.appendChild(document.createTextNode('This page is selected. '));
      var b=el('button','link-btn','Select all '+total.toLocaleString('en-US')+' matching domains');b.type='button';b.addEventListener('click',function(){allMatching=true;loadRows()});box.appendChild(b);
    }else if(allMatching){box.hidden=false;box.textContent='';box.appendChild(document.createTextNode('All '+total.toLocaleString('en-US')+' matching domains are selected. '));
      var c=el('button','link-btn','Clear selection');c.type='button';c.addEventListener('click',function(){allMatching=false;selected.clear();loadRows()});box.appendChild(c)}
    else box.hidden=true;
  }
  $('tg-checkall').addEventListener('change',function(){rows.forEach(function(r){if($('tg-checkall').checked)selected.add(r.domain);else selected.delete(r.domain)});if(!$('tg-checkall').checked)allMatching=false;loadRows()});
  function refilter(){page=1;selected.clear();allMatching=false;loadRows()}
  var timer=null;$('tg-q').addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(refilter,250)});
  $('tg-show').addEventListener('change',refilter);$('tg-tagsel').addEventListener('change',refilter);
  $('tg-prev').addEventListener('click',function(){page--;loadRows()});$('tg-next').addEventListener('click',function(){page++;loadRows()});

  function bulk(kind){
    var name=$('tg-tagname').value.trim();if(!name){say($('tg-msg'),false,'Type a tag name first.');return}
    var n=allMatching?total:selected.size;if(!n){say($('tg-msg'),false,'Select some domains first.');return}
    var body={action:'tags_apply'};body[kind]=[name];
    if(allMatching)body.match=selector();else body.domains=Array.from(selected);
    $('tg-add').disabled=$('tg-remove').disabled=true;
    call(body).then(function(r){
      var t=(kind==='add'?'Added "':'Removed "')+name+'" '+(kind==='add'?'to ':'from ')+r.domains+' domain'+(r.domains===1?'':'s')+'.';
      if(r.skippedCount)t+=' '+r.skippedCount+' already had the maximum number of tags.';
      if(r.keptByRule)t+=' '+r.keptByRule+' still have it because of a rule.';
      say($('tg-msg'),true,t);selected.clear();allMatching=false;return refresh();
    }).catch(function(e){say($('tg-msg'),false,e.message.trim())}).finally(function(){$('tg-add').disabled=$('tg-remove').disabled=false});
  }
  $('tg-add').addEventListener('click',function(){bulk('add')});$('tg-remove').addEventListener('click',function(){bulk('remove')});

  var checked=false;
  function importBody(dry){return {action:'tags_import',text:$('tg-import').value,mode:document.querySelector('input[name=tg-mode]:checked').value,dryRun:dry}}
  function showErrors(r){var pre=$('tg-import-errors');if(r.errors&&r.errors.length){pre.hidden=false;pre.textContent=r.errors.map(function(e){return (e.line?'Line '+e.line+': ':'')+e.reason}).join('\\n')+(r.errorCount>r.errors.length?'\\n...and '+(r.errorCount-r.errors.length)+' more':'')}else pre.hidden=true}
  $('tg-import').addEventListener('input',function(){checked=false;$('tg-import-apply').disabled=true});
  $('tg-import-preview').addEventListener('click',function(){
    call(importBody(true)).then(function(r){showErrors(r);checked=r.domains>0;$('tg-import-apply').disabled=!checked;
      say($('tg-import-msg'),r.domains>0,r.domains?r.domains+' domain'+(r.domains===1?'':'s')+' with '+r.tags+' tag'+(r.tags===1?'':'s')+' will be imported'+(r.errorCount?'; '+r.errorCount+' line'+(r.errorCount===1?'':'s')+' will be skipped.':'.'):'Nothing to import.')}).catch(function(e){say($('tg-import-msg'),false,e.message.trim())});
  });
  $('tg-import-apply').addEventListener('click',function(){
    if(!checked)return;$('tg-import-apply').disabled=true;
    call(importBody(false)).then(function(r){showErrors(r);say($('tg-import-msg'),true,'Imported '+r.domains+' domain'+(r.domains===1?'':'s')+'.');$('tg-import').value='';checked=false;return refresh()}).catch(function(e){say($('tg-import-msg'),false,e.message.trim());$('tg-import-apply').disabled=false});
  });

  function refresh(){return call({action:'tags_overview'}).then(function(o){TG=o;renderTags();renderRules();return loadRows()})}
  renderTags();renderRules();loadRows();
})();
`;

