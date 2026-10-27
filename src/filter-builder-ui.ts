// The filter builder: rows of "field / operator / value" joined by all-of (AND) or any-of (OR),
// in groups that can be inverted (NOT). It is a small component used twice: in the filter bar of
// every dashboard page, and in Admin for the automatic tagging rules.
//
// It works on the plain form from domain-filter.ts (`{ all: [...] }`, `{ any: [...], not: true }`,
// `{ field, op, value }`) and builds its DOM with createElement, never innerHTML.

import { OPS } from "./domain-filter.ts";

export const FILTER_BUILDER_CSS = `
.fb-panel { width: min(700px, 94vw); left: auto; right: 0; padding: 14px; }
.fb-group { border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--surface); }
.fb-group.nested { background: var(--surface-2); margin: 2px 0 2px 16px; box-shadow: inset 3px 0 0 var(--accent-soft); }

/* every control is the same height and font, so rows line up */
.fb-group select, .fb-group input[type=text] {
  box-sizing: border-box; height: 34px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 8px;
  background-color: var(--surface); color: var(--text); font-family: inherit; font-size: 13px; line-height: 1;
}
.fb-group select { padding-right: 32px; text-overflow: ellipsis; }
.fb-group input[type=text]::placeholder { color: var(--muted); }
.fb-group select:focus, .fb-group input[type=text]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }

.fb-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: 10px; font-size: 13px; font-weight: 600; }
.fb-head .fb-x { margin-left: auto; }
.fb-not { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12.5px; font-weight: 500; cursor: pointer; }
.fb-not input { accent-color: var(--accent); margin: 0; }

/* field | operator | value | remove: the same columns in every row */
.fb-row { display: grid; grid-template-columns: 104px 172px minmax(0, 1fr) 30px; gap: 8px; align-items: center; }
.fb-row .fb-fixed { font-size: 13px; font-weight: 600; color: var(--muted); padding-left: 2px; }
.fb-row .fb-val { min-width: 0; width: 100%; }
.fb-join { display: flex; align-items: center; gap: 10px; margin: 7px 0; color: var(--muted); font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.fb-join::after { content: ""; flex: 1; height: 1px; background: var(--border); }

.fb-x { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; background: none; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; border-radius: 8px; padding: 0; }
.fb-x:hover { color: var(--bad); background: var(--surface-2); }
.fb-foot { display: flex; gap: 8px; margin-top: 12px; }
.fb-add { height: 30px; border: 1px dashed var(--border-strong); background: none; color: var(--accent-text); border-radius: 8px; padding: 0 12px; font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; }
.fb-add:hover { border-color: var(--accent); background: var(--accent-soft); }
.fb-count { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; text-align: center; }
.fb-err { color: var(--bad); font-size: 12.5px; padding: 8px 2px 2px; }
.fb-panel .dms-foot { margin-top: 12px; }

@media (max-width: 640px) {
  .fb-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 30px; }
  .fb-row .fb-val { grid-column: 1 / 3; }
  .fb-row .fb-spacer { display: none; }
}
`;

export const FILTER_BUILDER_JS = `
window.DCFilter=(function(){
  var MAX_DEPTH=3,uid=0;
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
  function fromWire(w){
    if(!w||typeof w!=='object')return null;
    if(w.all||w.any){var mode=w.all?'all':'any';return {mode:mode,not:!!w.not,items:(w[mode]||[]).map(fromWire).filter(Boolean)}}
    return {field:w.field,op:w.op,value:Array.isArray(w.value)?w.value.join(', '):(w.value===undefined?'':w.value)};
  }
  function toWire(n){
    if(n.items){var items=n.items.map(toWire).filter(Boolean);if(!items.length)return null;var g={};g[n.mode]=items;if(n.not)g.not=true;return g}
    var c={field:n.field,op:n.op};if(n.value!==undefined&&String(n.value).trim()!=='')c.value=String(n.value).trim();return c;
  }
  function leaves(n){return n.items?n.items.reduce(function(a,i){return a+leaves(i)},0):1}
  function mount(root,o){
    var ops=o.ops,fields=o.fields,tags=o.tags||[],labels={tag:'Tag',domain:'Domain',policy:'Policy'};
    var state=fromWire(o.initial)||{mode:'all',not:false,items:[]};
    var onChange=o.onChange||function(){};
    var listId='fb-tags-'+(++uid);
    var dl=el('datalist');dl.id=listId;tags.forEach(function(t){var op=el('option');op.value=t.tag||t;dl.appendChild(op)});
    function opsFor(f){return ops.filter(function(x){return x.field===f})}
    function kind(c){var x=ops.filter(function(p){return p.field===c.field&&p.op===c.op})[0];return x?x.value:'one'}
    function defaultCond(){var f=fields[0];return {field:f,op:opsFor(f)[0].op,value:''}}
    function select(options,value,onSel){
      var s=el('select');options.forEach(function(x){var op=el('option',null,x[1]);op.value=x[0];if(x[0]===value)op.selected=true;s.appendChild(op)});
      s.addEventListener('change',function(){onSel(s.value)});return s;
    }
    function renderCond(c,parent){
      var row=el('div','fb-row');
      if(fields.length>1)row.appendChild(select(fields.map(function(f){return [f,labels[f]]}),c.field,function(v){c.field=v;c.op=opsFor(v)[0].op;c.value='';render()}));
      else row.appendChild(el('span','fb-fixed',labels[c.field]));
      row.appendChild(select(opsFor(c.field).map(function(x){return [x.op,x.label]}),c.op,function(v){var was=kind(c);c.op=v;if(kind(c)!==was)c.value='';render()}));
      var k=kind(c);
      if(k!=='none'){
        if(c.field==='policy'&&k==='one'){
          var ps=select([['none','none'],['quarantine','quarantine'],['reject','reject'],['unknown','unknown (no report yet)']],c.value||'none',function(v){c.value=v;onChange()});ps.className='fb-val';row.appendChild(ps);
          if(!c.value)c.value='none';
        }else{
          var i=el('input','fb-val');i.type='text';i.value=c.value||'';i.autocomplete='off';i.spellcheck=false;
          i.placeholder=k==='many'?(c.field==='policy'?'none, quarantine':(c.field==='tag'?'emea, prod':'a.com, b.com')):(c.field==='tag'?'tag name':'text');
          i.setAttribute('aria-label','Value');
          if(c.field==='tag')i.setAttribute('list',listId);
          i.addEventListener('input',function(){c.value=i.value;onChange()});
          row.appendChild(i);
        }
      }
      if(k==='none')row.appendChild(el('span','fb-spacer'));
      var x=el('button','fb-x','\\u00d7');x.type='button';x.setAttribute('aria-label','Remove condition');
      x.addEventListener('click',function(){parent.items.splice(parent.items.indexOf(c),1);render()});
      row.appendChild(x);return row;
    }
    function renderGroup(g,depth,parent){
      var box=el('div','fb-group'+(depth?' nested':''));
      var head=el('div','fb-head');
      head.appendChild(el('span',null,'Match'));
      head.appendChild(select([['all','all of (AND)'],['any','any of (OR)']],g.mode,function(v){g.mode=v;render()}));
      head.appendChild(el('span',null,'the following'));
      var nl=el('label','fb-not');var nc=el('input');nc.type='checkbox';nc.checked=!!g.not;
      nc.addEventListener('change',function(){g.not=nc.checked;onChange()});nl.appendChild(nc);nl.appendChild(document.createTextNode('Not (invert this group)'));head.appendChild(nl);
      if(parent){var rx=el('button','fb-x','\\u00d7');rx.type='button';rx.setAttribute('aria-label','Remove group');rx.addEventListener('click',function(){parent.items.splice(parent.items.indexOf(g),1);render()});head.appendChild(rx)}
      box.appendChild(head);
      g.items.forEach(function(it,idx){
        if(idx>0)box.appendChild(el('div','fb-join',g.mode==='all'?'and':'or'));
        box.appendChild(it.items?renderGroup(it,depth+1,g):renderCond(it,g));
      });
      var foot=el('div','fb-foot');
      var a=el('button','fb-add','+ Condition');a.type='button';a.addEventListener('click',function(){g.items.push(defaultCond());render()});foot.appendChild(a);
      if(depth<MAX_DEPTH-1){var b=el('button','fb-add','+ Group');b.type='button';b.addEventListener('click',function(){g.items.push({mode:'any',not:false,items:[defaultCond()]});render()});foot.appendChild(b)}
      box.appendChild(foot);return box;
    }
    function render(){root.textContent='';root.appendChild(dl);root.appendChild(renderGroup(state,0,null));onChange()}
    function validate(n){
      n=n||state;
      if(n.items){for(var i=0;i<n.items.length;i++){var e=validate(n.items[i]);if(e)return e}return null}
      if(kind(n)!=='none'&&String(n.value===undefined?'':n.value).trim()==='')return 'Enter a value for every condition, or remove the empty ones.';
      return null;
    }
    render();
    return {get:function(){return toWire(state)},validate:function(){return validate()},count:function(){return leaves(state)}};
  }
  return {mount:mount,leaves:function(w){var n=fromWire(w);return n?leaves(n):0}};
})();
`;

export const FILTER_BAR_JS = `
(function(){
  var data=JSON.parse(document.getElementById('fb-data').textContent);
  var trigger=document.getElementById('fb-trigger'),panel=document.getElementById('fb-panel'),msg=document.getElementById('fb-msg');
  var builder=null;
  function close(){panel.hidden=true;trigger.setAttribute('aria-expanded','false')}
  function open(){
    panel.hidden=false;trigger.setAttribute('aria-expanded','true');
    if(!builder)builder=DCFilter.mount(document.getElementById('fb-root'),{ops:data.ops,fields:['tag','domain','policy'],tags:data.tags,initial:data.expr,onChange:function(){msg.textContent=''}});
    if(builder.count()===0){document.querySelector('#fb-root .fb-add').click()}
    place();
  }
  /* The panel hangs from the Filter button's right edge. When the top bar wraps (a long filter description) the button
     moves left and that would push the panel off the screen, so keep it inside the window. */
  function place(){
    panel.style.left='';panel.style.right='';
    var r=panel.getBoundingClientRect(),w=document.documentElement.clientWidth;
    if(r.left<8)panel.style.right=(parseFloat(getComputedStyle(panel).right)||0)+(r.left-8)+'px';
    r=panel.getBoundingClientRect();
    if(r.right>w-8)panel.style.right=(parseFloat(getComputedStyle(panel).right)||0)+(r.right-(w-8))+'px';
  }
  window.addEventListener('resize',function(){if(!panel.hidden)place()});
  trigger.addEventListener('click',function(e){e.stopPropagation();panel.hidden?open():close()});
  panel.addEventListener('click',function(e){e.stopPropagation()});
  document.addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!panel.hidden){close();trigger.focus()}});
  function go(expr){
    var u=new URL(location.href);u.searchParams.delete('page');u.searchParams.delete('tag');
    if(expr)u.searchParams.set('f',JSON.stringify(expr));else u.searchParams.delete('f');
    location.href=u.pathname+u.search;
  }
  document.getElementById('fb-apply').addEventListener('click',function(){
    var err=builder.validate();if(err){msg.textContent=err;msg.className='fb-err';return}
    go(builder.get());
  });
  document.getElementById('fb-clear').addEventListener('click',function(){go(null)});
})();
`;

export const FILTER_OPS = OPS;
