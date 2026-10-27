// The small editor that opens from the "+" in a domain's Tags cell on the Domains page, so a
// domain can be tagged right where it is listed. Shown only to someone signed in with the
// login page; it calls the same action as the Tags page.

export const TAG_EDIT_JS = `
(function(){
  var info=JSON.parse(document.getElementById('te-tags').textContent),names=info.names,colors=info.colors||{};
  var pop=null;
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
  function close(){if(pop){pop.remove();pop=null}}
  function post(body){
    return fetch('/admin',{method:'POST',headers:{'content-type':'application/json','x-settings-request':'1'},body:JSON.stringify(body)}).then(function(r){
      if(r.status===401){location.href='/login?next='+encodeURIComponent(location.pathname+location.search);throw new Error('Please sign in again.')}
      return r.text().then(function(t){if(!r.ok){var m;try{m=JSON.parse(t).error}catch(e){m=t}throw new Error((m||'That did not work.').trim())}return t});
    });
  }
  function open(b){
    var domain=b.getAttribute('data-domain'),manual=JSON.parse(b.getAttribute('data-manual')),auto=JSON.parse(b.getAttribute('data-auto'));
    var p=el('div','te-pop');p._for=b;p.setAttribute('role','dialog');p.setAttribute('aria-label','Tags of '+domain);
    p.appendChild(el('div','te-title',domain));
    var chips=el('div','te-chips');
    var err=el('div','te-err');err.setAttribute('role','alert');
    manual.forEach(function(t){
      var c=el('span','te-chip',t);c.setAttribute('data-c',colors[t]||'gray');var x=el('button',null,'\\u00d7');x.type='button';x.setAttribute('aria-label','Remove '+t);
      x.addEventListener('click',function(){x.disabled=true;post({action:'tags_apply',domains:[domain],remove:[t]}).then(function(){location.reload()}).catch(function(e){err.textContent=e.message;x.disabled=false})});
      c.appendChild(x);chips.appendChild(c);
    });
    auto.forEach(function(t){var c=el('span','te-chip tag auto',t);c.setAttribute('data-c',colors[t]||'gray');c.title='From an automatic rule: change the rule to remove it';chips.appendChild(c)});
    if(!manual.length&&!auto.length)chips.appendChild(el('span','hint','No tags yet.'));
    p.appendChild(chips);
    var row=el('div','te-row');
    var inp=el('input');inp.type='text';inp.placeholder='Add a tag';inp.maxLength=32;inp.autocomplete='off';inp.setAttribute('aria-label','Tag to add');
    var dl=el('datalist');dl.id='te-list';names.forEach(function(n){var o=el('option');o.value=n;dl.appendChild(o)});inp.setAttribute('list','te-list');
    var add=el('button','btn','Add');add.type='button';
    function go(){
      var v=inp.value.trim();if(!v){err.textContent='Type a tag name.';return}
      add.disabled=true;post({action:'tags_apply',domains:[domain],add:[v]}).then(function(){location.reload()}).catch(function(e){err.textContent=e.message;add.disabled=false});
    }
    add.addEventListener('click',go);inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();go()}});
    row.appendChild(inp);row.appendChild(add);row.appendChild(dl);p.appendChild(row);p.appendChild(err);
    document.body.appendChild(p);
    var r=b.getBoundingClientRect();
    p.style.top=(r.bottom+window.scrollY+6)+'px';
    p.style.left=Math.max(8,Math.min(r.left+window.scrollX,window.innerWidth-p.offsetWidth-12))+'px';
    pop=p;inp.focus();
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('.tag-edit');
    if(!b){if(pop&&!e.target.closest('.te-pop'))close();return}
    e.preventDefault();e.stopPropagation();
    var same=pop&&pop._for===b;close();if(!same)open(b);
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
})();
`;
