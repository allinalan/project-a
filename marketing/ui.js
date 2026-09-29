// Marketing page for the Command Center: rendering and interaction only.
// Every rule lives in marketing/engine.js (MAEngine); the calendar core in marketing/calcore.js.
// The plan lives in the Command Center Marketing store (Apps Script), not in data.json or the
// HUB's Sheets snapshot: this page loads it when it opens and saves each edit a moment later.
// If anything else saved first (the Monday calendar check, ALMA filing a Claude draft, another
// device), the save is refused, the page takes the newer plan and re-applies your edit on top.
var MA = (function (E, CalCore) {
  'use strict';

  // ───────────────────────── setup ─────────────────────────
  const qp = new URLSearchParams(location.search);
  const OVERRIDE = /^\d{4}-\d{2}-\d{2}$/.test(qp.get('today') || '') ? qp.get('today') : '';
  const T = () => OVERRIDE || E.iso(new Date());
  const nowIso = () => new Date().toISOString();
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const LS_KEY = 'ma_key', LS_CACHE = 'ma_cache_v1', LS_UI = 'ma_ui_v1';
  const lsGet = k => { try{ return localStorage.getItem(k); }catch(e){ return null; } };
  const lsSet = (k, v) => { try{ localStorage.setItem(k, v); }catch(e){} };
  const lsDel = k => { try{ localStorage.removeItem(k); }catch(e){} };
  const parse = s => { try{ return JSON.parse(s); }catch(e){ return null; } };
  // A dev store URL is honored only on localhost, so a link can never point this page (and its key) elsewhere.
  const storeUrl = () => (LOCAL && qp.get('store')) || window.MA_STORE_URL || '';
  const esc = E.esc;
  const TABS = [['all','All marketing','All'], ['show','Event marketing','Events'], ['se','Service event marketing','Service events'], ['sale','Sale marketing','Sales']];
  const KC = t => ({show:'k-show', se:'k-se', sale:'k-sale'}[t] || 'k-other');
  const isPhone = () => window.matchMedia('(max-width:700px)').matches;

  const ui = Object.assign({tab:'all', bview:'month', list:'upcoming', plan:''}, parse(lsGet(LS_UI)) || {});
  const saveUi = () => lsSet(LS_UI, JSON.stringify(ui));
  let cursor = T().slice(0,7), selDay = '', openRow = '', showAllFlags = false;
  const db = {state:null, rev:0, status:'init', msg:'', queue:[], busy:false, loadedAt:0, savedAt:'', cachedAt:'', calBusy:false, retry:null};

  const PK = () => { const st = db.state; if(!st) return ''; return ui.plan && st.plans[ui.plan] ? ui.plan : st.active; };
  const P = () => db.state.plans[PK()];
  const byId = id => P().items.find(x => x.id === id);
  const inTab = type => ui.tab === 'all' || type === ui.tab;
  const tabShort = () => TABS.find(t => t[0] === ui.tab)[2];

  // ───────────────────────── the store ─────────────────────────
  async function call(action, extra){
    const url = storeUrl();
    if(!url) throw new Error('The marketing store isn’t set up yet.');
    const res = await fetch(url, {method:'POST', body:JSON.stringify(Object.assign({action, key:lsGet(LS_KEY) || ''}, extra || {}))});
    if(!res.ok) throw new Error('The store answered HTTP '+res.status+'.');
    const o = parse(await res.text());
    if(!o) throw new Error('The store sent back something that isn’t JSON. Is the Apps Script deployed as a web app for Anyone?');
    return o;
  }
  function setStatus(s, msg){ db.status = s; db.msg = msg || ''; renderSync(); renderHomeCard(); }
  function adopt(doc, rev){
    db.state = E.migrate(JSON.parse(doc)); db.rev = rev; db.loadedAt = Date.now();
    lsSet(LS_CACHE, JSON.stringify({rev, doc, at:nowIso()}));
  }
  async function loadStore(){
    if(!storeUrl()){ setStatus('nourl'); render(); return; }
    if(!lsGet(LS_KEY)){ setStatus('nokey'); render(); return; }
    if(db.queue.length || db.busy) return; // unsaved edits first; the save reconciles with the store
    if(!db.state) setStatus('loading');
    try{
      const o = await call('load');
      if(db.queue.length || db.busy) return;
      if(!o.ok){ if(o.error === 'bad_key') lsDel(LS_KEY); setStatus(o.error === 'bad_key' ? 'badkey' : 'error', o.message); render(); return; }
      if(!o.rev){ db.state = null; db.rev = 0; setStatus('empty'); render(); return; }
      if(o.rev !== db.rev || !db.state) adopt(o.doc, o.rev); else db.loadedAt = Date.now();
      setStatus('ok'); render();
    }catch(e){ setStatus(db.state ? 'offline' : 'error', e.message); render(); }
  }
  // Apply an edit here now; it reaches the store a moment later. fn must be re-runnable on a newer plan.
  function commit(label, fn){
    if(!db.state) return;
    try{ fn(db.state); }catch(e){ console.error('marketing edit failed', e); toast('That didn’t work: '+e.message); return; }
    db.queue.push({label, fn});
    render(); scheduleSave(500);
  }
  function commitItem(label, id, fn){
    const pk = PK();
    commit(label, st => { const x = E.findItem(st, pk, id); if(x) fn(x, st.plans[pk], st); });
  }
  function scheduleSave(ms){ clearTimeout(db.retry); db.retry = setTimeout(flush, ms); }
  async function flush(){
    if(db.busy || !db.queue.length) return;
    db.busy = true; setStatus('saving');
    try{
      for(let attempt = 0; attempt < 5; attempt++){
        const n = db.queue.length, doc = JSON.stringify(db.state), h = E.hash(doc);
        const o = await call('save', {baseRev:db.rev, doc, hash:h, source:'page', note:db.queue.slice(0, n).map(q => q.label).join('; ').slice(0, 200)});
        if(o.ok && o.hash === h){
          db.rev = o.rev; db.queue.splice(0, n); db.savedAt = o.savedAt; db.loadedAt = Date.now();
          lsSet(LS_CACHE, JSON.stringify({rev:o.rev, doc, at:nowIso()}));
          if(!db.queue.length){ setStatus('saved'); break; }
          continue;
        }
        if(o.error === 'conflict'){ // something else saved first: take the newer plan, replay my edits on top
          const theirs = E.migrate(JSON.parse(o.doc));
          db.queue.forEach(q => { try{ q.fn(theirs); }catch(e){ console.error('replay failed', q.label, e); } });
          db.state = theirs; db.rev = o.rev; render();
          continue;
        }
        if(o.error === 'bad_key'){ setStatus('badkey', o.message); return; }
        throw new Error(o.message || o.error || 'The save was refused.');
      }
      if(db.queue.length) throw new Error('The store kept changing underneath this save.');
    }catch(e){
      setStatus('unsaved', e.message);
      db.busy = false; scheduleSave(15000); return;
    }finally{ db.busy = false; }
    render();
  }
  window.addEventListener('beforeunload', e => { if(db.queue.length){ e.preventDefault(); e.returnValue = ''; } });

  // ───────────────────────── render: page ─────────────────────────
  const pageEl = () => document.getElementById('page-marketing');
  const active = () => { const p = pageEl(); return !!p && p.classList.contains('active'); };
  function render(){
    renderHomeCard();
    const root = document.getElementById('maRoot'); if(!root) return;
    if(!db.state){ root.innerHTML = gate(); renderSync(); return; }
    const p = P(), today = T();
    const flAll = E.allFlags(db.state, today, PK());
    const fl = flAll.filter(f => ui.tab === 'all' || f.types.includes(ui.tab));
    root.innerHTML = head() + '<div class="ma-sync" id="maSync"></div>' + tabs(flAll) + read(p, fl)
      + '<div class="ma-g2"><section class="panel ma-panel">'+needsYou(fl)+'</section><section class="panel ma-panel">'+next14(p)+'</section></div>'
      + calendarSection(p);
    renderSync();
    refreshOpenSheet();
  }
  function gate(){
    const s = db.status, url = storeUrl();
    const title = '<div class="eyebrow">Marketing Advisor</div><div class="ptitle">The Marketing Plan<span>.</span></div>';
    if(!url) return title+'<div class="panel ma-gate"><h3>The marketing store isn’t set up yet.</h3><p>Once the Command Center Marketing Apps Script is deployed, this page reads your plan from it.</p></div>';
    if(s === 'nokey' || s === 'badkey') return title+'<div class="panel ma-gate"><h3>Connect this device</h3>'
      + '<p>Paste your store key once. It stays on this device only. It’s in the Apps Script’s setup log, or under Project Settings → Script properties → MA_KEY.</p>'
      + '<div class="ma-keyrow"><input type="password" id="maKeyIn" autocomplete="off" spellcheck="false" placeholder="Store key" aria-label="Store key"><button class="ma-btn ma-go" data-ma="connect">Connect</button></div>'
      + (s === 'badkey' ? '<p class="ma-err">That key didn’t match the store. Check it and try again.</p>' : '')+'</div>';
    if(s === 'empty') return title+'<div class="panel ma-gate"><h3>Connected. The store is empty.</h3><p>The 2026–27 plan gets loaded into it once; after that it lives here.</p></div>';
    if(s === 'error') return title+'<div class="panel ma-gate"><h3>Couldn’t load your plan.</h3><p class="ma-err">'+esc(db.msg)+'</p><button class="ma-btn" data-ma="reload">Try again</button></div>';
    return title+'<div class="panel ma-gate"><p class="ma-muted">Loading your plan…</p></div>';
  }
  function head(){
    const st = db.state, pk = PK();
    const opts = Object.keys(st.plans).sort().map(k => '<option value="'+esc(k)+'"'+(k === pk ? ' selected' : '')+'>'+esc(k)+' plan</option>').join('')
      + '<option value="__next">Start next year’s plan…</option>';
    return '<div class="ma-head"><div class="ma-titles"><div class="eyebrow">Marketing Advisor</div><div class="ptitle">The Marketing Plan<span>.</span></div></div>'
      + '<div class="ma-acts"><select class="ma-plansel" data-ma-chg="plan" aria-label="Plan year">'+opts+'</select>'
      + '<button class="ma-btn ma-wide" data-ma="rules">Rules</button><button class="ma-btn ma-wide" data-ma="pdf">Export PDF</button>'
      + '<button class="ma-btn ma-go" data-ma="add">Add to plan</button><button class="ma-btn ma-narrow" data-ma="menu" aria-label="More">•••</button></div></div>';
  }
  function renderSync(){
    const el = document.getElementById('maSync'); if(!el) return;
    const t = iso => { try{ return new Date(iso).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }catch(e){ return ''; } };
    const cached = parse(lsGet(LS_CACHE));
    const s = db.status;
    const text = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved ✓ '+t(db.savedAt) : s === 'ok' ? 'Up to date' : s === 'loading' ? 'Loading…'
      : s === 'offline' ? 'Offline. Showing your copy from '+(cached ? new Date(cached.at).toLocaleString([], {month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit'}) : 'earlier')+'. Edits wait here until the store answers.'
      : s === 'unsaved' ? 'Not saved yet ('+db.msg+'). Retrying.' : '';
    el.className = 'ma-sync'+(s === 'unsaved' || s === 'offline' ? ' warn' : '');
    el.textContent = text;
  }
  function tabs(flAll){
    return '<div class="ma-tabs" role="tablist" aria-label="Marketing type">'+TABS.map(([k, label, short]) => {
      const n = k === 'all' ? flAll.length : flAll.filter(f => f.types.includes(k)).length;
      return '<button class="ma-tab'+(ui.tab === k ? ' on' : '')+'" role="tab" aria-selected="'+(ui.tab === k)+'" data-ma="tab" data-a="'+k+'"><span class="tl">'+label+'</span><span class="ts">'+short+'</span>'+(n ? '<span class="n" aria-label="'+n+' need you">'+n+'</span>' : '')+'</button>';
    }).join('')+'</div>';
  }
  function read(p, fl){
    const today = T();
    const nextSend = E.reminders(p, today, true).find(x => x.k && x.date >= today && inTab(x.type));
    let lead;
    if(fl.length){
      const f = fl[0], first = E.plain(f.text).replace(/\*/g, '').split(/(?<=[.?])\s/)[0];
      lead = '<b>'+fl.length+' thing'+(fl.length > 1 ? 's' : '')+' need'+(fl.length > 1 ? '' : 's')+' you.</b> First up'+(f.due && f.due.length === 10 && f.due >= today ? ', by '+E.dmd(f.due) : '')+': '+esc(first);
    } else lead = ui.tab === 'all' ? '<b>Your plan is clean.</b> Nothing needs a decision right now.' : '<b>'+tabShort()+' are clean.</b> Nothing needs a decision right now.';
    const sub = nextSend ? 'Next send: '+nextSend.text.replace(' goes out:', ' for')+', '+E.dmd(nextSend.date)+'.' : 'No sends scheduled yet.';
    return '<div class="ma-read"><p>'+lead+'</p><div class="ma-read-sub"><span>'+esc(sub)+'</span>'+calLine()+'</div></div>';
  }
  function calLine(){
    const c = db.state.cal || {}, lr = c.lastRun;
    let t;
    if(db.calBusy) t = 'Checking your calendar…';
    else if(!lr) t = 'Calendar not checked yet';
    else if(!lr.ok) t = 'Calendar check failed '+E.dmd(lr.at.slice(0,10));
    else {
      const a = E.calAnalysis(db.state, T());
      const q = a ? a.weak.length + a.missing.length + a.fresh.filter(f => f.pk === PK()).length : 0;
      const moved = (c.log || []).filter(l => l.at && l.at >= (lr.at || '').slice(0,10)).length;
      t = 'Calendar checked '+E.dmd(lr.at.slice(0,10))+(moved ? ', '+moved+' date'+(moved > 1 ? 's' : '')+' moved' : '')+(q ? ', '+q+' question'+(q > 1 ? 's' : '') : '');
    }
    return '<button class="ma-link'+(lr && !lr.ok ? ' bad' : '')+'" data-ma="calsheet">'+esc(t)+' ›</button>';
  }

  // Needs you: plan problems and the calendar's questions, in one list
  function flagActs(f){
    const a = [], btn = (act, label, extra, primary) => '<button class="'+(primary ? 'primary' : '')+'" data-ma="'+act+'"'+(extra || '')+'>'+label+'</button>';
    const dk = ' data-a="'+esc(f.key)+'"';
    if(f.cal === 'weak') return btn('calyes', 'Same, use calendar dates', ' data-a="'+esc(f.ref)+'"', true)+btn('calno', 'Different', ' data-a="'+esc(f.ref)+'"');
    if(f.cal === 'missing') return btn('calstill', 'Still on', ' data-a="'+esc(f.ref)+'"')+btn('calremove', 'Remove', ' data-a="'+esc(f.ref)+'"');
    if(f.cal === 'fresh') return btn('calsheet', 'Go through them', '', true)+btn('dismiss', 'Later', dk);
    if(f.cal === 'outside') return btn('rollover', 'Start next year’s plan', '', true)+btn('dismiss', 'Later', dk);
    if(f.cal === 'error') return btn('calcheck', 'Check now', '', true)+btn('calsheet', 'Details', '');
    if(f.review) return btn('edit', f.draft ? 'Take a look' : 'Review it', ' data-a="'+esc(f.id)+'" data-b="review"', true);
    if(f.id) a.push(btn('edit', 'Open', ' data-a="'+esc(f.id)+'"', true));
    if(f.rules) a.push(btn('rules', 'Open rules', '', true));
    if(f.kick) a.push(btn('kick', 'Add the email', ' data-a="'+esc(f.kick)+'"', true));
    if(f.dismiss || f.sev === 'ask') a.push(btn('dismiss', f.doneLabel || 'Looks right', dk));
    return a.join('');
  }
  function needsYou(fl){
    const cap = isPhone() ? 3 : 5, shown = showAllFlags ? fl : fl.slice(0, cap);
    const h = '<div class="phead"><div class="ptit2">Needs you</div><span class="ma-sub">'+(fl.length ? fl.length+' open' : 'All clear')+'</span></div>';
    if(!fl.length) return h+'<p class="ma-empty">'+(ui.tab === 'all' ? 'Nothing needs you right now. Every upcoming event has dates, an audience, and its sends lined up.' : 'Nothing needs you in '+tabShort().toLowerCase()+' right now.')+'</p>';
    return h+shown.map(f => '<div class="ma-flag '+f.sev+'"><div class="when">'+(f.due && f.due.length === 10 ? E.dmd(f.due) : '')+'</div><div class="what">'+f.text+'</div><div class="acts">'+flagActs(f)+'</div></div>').join('')
      + (fl.length > cap ? '<button class="ma-more" data-ma="flagsmore">'+(showAllFlags ? 'Show fewer' : 'Show all '+fl.length)+'</button>' : '');
  }

  // ───────────────────────── agenda (Next 14 days, and a picked week) ─────────────────────────
  function dayMap(p, from, to){
    const r = p.rules, days = {}, today = T();
    for(let d = from; d <= to; d = E.addDays(d, 1)) days[d] = [];
    p.items.filter(x => inTab(x.type)).forEach(x => {
      E.sendsFor(x, r).forEach(s => { if(days[s.date]) days[s.date].push({kind:'send', x, s}); });
      if(x.start && !x.kickoff){
        const end = x.end || x.start;
        if(x.start >= from && x.start <= to) days[x.start].push({kind:'run', x});
        else if(x.start < from && end >= from) days[from].push({kind:'run', x, running:true});
      }
    });
    E.reminders(p, today, true).filter(m => !m.k && m.date >= from && m.date <= to && (ui.tab === 'all' || m.type === ui.tab)).forEach(m => days[m.date].push({kind:'rem', m}));
    Object.keys(days).forEach(d => days[d].sort((a, b) => ({send:0, run:1, rem:2}[a.kind] - {send:0, run:1, rem:2}[b.kind])));
    return days;
  }
  function prepBadge(l){
    if(!l.length) return '';
    const stale = l.some(t => t.stale), n = E.prepDone(l);
    return '<span class="ma-pp'+(stale ? ' warn' : n === l.length ? ' full' : '')+'">'+(stale ? 'Reschedule' : (n === l.length ? '✓ ' : '')+n+'/'+l.length)+'</span>';
  }
  function ckLine(t, id, inEditor){
    const data = ' data-a="'+esc(id)+'" data-b="'+esc(t.key)+'"';
    if(t.stale) return '<div class="ma-ck stale"><input type="checkbox" checked disabled aria-label="'+esc(t.label)+'"><span>'+esc(t.label)+'<small>Scheduled for '+E.md(t.was)+', now goes out '+E.dmd(t.date)+'</small></span><button class="ma-mini" data-ma="'+(inEditor ? 'edresched' : 'resched')+'"'+data+'>Rescheduled</button></div>';
    return '<label class="ma-ck'+(t.done ? ' done' : '')+'"><input type="checkbox"'+(t.done ? ' checked' : '')+' data-ma-chg="'+(inEditor ? 'edprep' : 'prep')+'"'+data+'><span>'+esc(t.label)+(t.date ? '<small>'+E.dmd(t.date)+'</small>' : '')+'</span></label>';
  }
  const PREP_GROUP = {email:'Email', text:'Text', event:'Event prep'};
  function ckLines(l, id, grouped, inEditor){
    if(!grouped) return l.map(t => ckLine(t, id, inEditor)).join('');
    return ['email','text','event'].map(g => { const gl = l.filter(t => t.scope === g); return gl.length ? '<div class="ma-ckg">'+PREP_GROUP[g]+'</div>'+gl.map(t => ckLine(t, id, inEditor)).join('') : ''; }).join('');
  }
  function agendaRow(p, e, d, from){
    const today = T();
    if(e.kind === 'rem'){
      const m = e.m, done = E.remDone(p, m);
      return '<label class="ma-ag-rem'+(done ? ' done' : '')+'"><input type="checkbox"'+(done ? ' checked' : '')+' data-ma-chg="remdone" data-a="'+esc(m.key)+'"><span>'+esc(m.text)+'<small>'+esc(m.sub || '')+'</small></span></label>';
    }
    const x = e.x, all = E.prepList(x, p.rules), send = e.kind === 'send' ? e.s : null;
    const l = send ? E.tasksFor(all, send) : all, rk = d+'|'+x.id+'|'+(send ? send.k : 'run'), open = openRow === rk;
    let lab, sub;
    if(send){
      lab = E.sendName(send)+' goes out'+(E.sendScheduled(x, send.k, send.date) ? ' · scheduled' : '');
      sub = esc(E.whoShort(x));
    } else {
      const st = x.status === 'possible' ? ', possible' : x.status === 'tbd' ? ', dates not confirmed' : '';
      lab = e.running ? 'Still running' : x.type === 'sale' ? 'Sale starts' : x.type === 'se' ? 'Service event' : x.type === 'show' ? 'Event' : E.TYPE[x.type];
      if(E.reviewable(x) && E.ended(x, today)) lab += ' · '+(x.review && x.review.next ? 'reviewed' : 'review it');
      sub = esc(E.rangeLabel(x))+esc(st)+(x.type !== 'sale' && E.whoShort(x) !== 'Audience TBD' ? ' · '+esc(E.whoShort(x)) : '');
    }
    let body = '';
    if(open){
      body = l.length ? '<div class="ma-prep" role="group" aria-label="Prep for '+esc(x.name)+'">'+ckLines(l, x.id, !send, false)
          + '<div class="ma-prep-foot"><span>'+E.prepDone(l)+' of '+l.length+' done</span><button class="ma-link" data-ma="edit" data-a="'+esc(x.id)+'">Open '+(x.type === 'se' ? 'service event' : 'event')+'</button></div></div>'
        : '<div class="ma-prep"><div class="ma-prep-foot"><span>Nothing to prep for this one.</span><button class="ma-link" data-ma="edit" data-a="'+esc(x.id)+'">Open</button></div></div>';
      if(!send && E.reviewable(x) && E.ended(x, today)) body += '<div class="ma-prep ma-rvbox"><div class="ma-ckg">Review</div>'+reviewInline(x)+'</div>';
    }
    return '<div class="ma-agw'+(open ? ' open' : '')+'"><button class="ma-agi '+(send ? '' : 'run ')+KC(x.type)+'" aria-expanded="'+open+'" data-ma="row" data-a="'+esc(rk)+'">'
      + '<span class="lab">'+lab+'</span>'+esc(x.name)+'<small>'+sub+'</small>'+prepBadge(l)+'</button>'+body+'</div>';
  }
  function agendaDays(p, from, to){
    const days = dayMap(p, from, to), today = T();
    let rows = '', nSend = 0; const nRun = new Set();
    Object.keys(days).sort().forEach(d => {
      const list = days[d]; if(!list.length) return;
      list.forEach(e => { if(e.kind === 'send') nSend++; if(e.kind === 'run') nRun.add(e.x.id); });
      const dt = E.pd(d), wk = dt.getDay() === 0 || dt.getDay() >= 5;
      rows += '<div class="ma-agd'+(d === today ? ' today' : '')+'"><div class="ma-agdate">'+(d === today ? 'Today' : E.DOW[dt.getDay()])+' '+E.md(d)+(wk && d !== today ? '<small>weekend</small>' : '')+'</div><div>'+list.map(e => agendaRow(p, e, d, from)).join('')+'</div></div>';
    });
    return {rows, nSend, nRun:nRun.size};
  }
  function next14(p){
    const today = T(), to = E.addDays(today, 13), from = E.addDays(today, -14);
    // overdue: sends that should have gone out and aren't marked scheduled, and open reminders
    const late = E.reminders(p, today, true).filter(x => x.date >= from && x.date < today && !E.remDone(p, x) && (ui.tab === 'all' || x.type === ui.tab));
    const lateHtml = late.length ? '<div class="ma-agd late"><div class="ma-agdate">Overdue</div><div>'+late.map(m => {
      if(m.k){ const x = p.items.find(y => y.id === m.id); return agendaRow(p, {kind:'send', x, s:m.send}, m.date, from); }
      return agendaRow(p, {kind:'rem', m}, m.date, from);
    }).join('')+'</div></div>' : '';
    const a = agendaDays(p, today, to);
    const noun = {all:'marketing', show:'event marketing', se:'service event marketing', sale:'sale marketing'}[ui.tab];
    const summary = a.nSend || a.nRun ? (a.nSend ? a.nSend+' send'+(a.nSend > 1 ? 's' : '') : 'No sends')+(a.nRun ? ', '+a.nRun+' happening' : '') : '';
    return '<div class="phead"><div class="ptit2">Next 14 days</div><span class="ma-sub">'+summary+'</span></div>'
      + (lateHtml + a.rows || '<p class="ma-empty">No '+noun+' going out or happening in the next two weeks.</p>');
  }
  function reviewInline(x){
    const r = Object.assign({liked:'', change:'', next:''}, x.review), id = esc(x.id);
    return '<div class="ma-rv">'
      + '<div class="ma-rv-q"><label>What worked</label><textarea data-ma-chg="rvtext" data-a="'+id+'" data-b="liked" placeholder="e.g. The raffle pulled people to the booth; the text got replies">'+esc(r.liked)+'</textarea></div>'
      + '<div class="ma-rv-q"><label>What to change next year</label><textarea data-ma-chg="rvtext" data-a="'+id+'" data-b="change" placeholder="e.g. Go 25 miles and add Tombstone; raffle the knife of the month instead">'+esc(r.change)+'</textarea></div>'
      + '<div class="ma-rv-q"><label>Next year</label><div class="ma-seg">'+E.NEXT.map(([k, l]) => '<button type="button" class="'+(r.next === k ? 'on' : '')+'" data-ma="rvnext" data-a="'+id+'" data-b="'+k+'">'+l+'</button>').join('')+'</div></div>'
      + draftLine(x)
      + (r.next === 'change' ? '<button class="ma-link" data-ma="edit" data-a="'+id+'" data-b="review">Edit next year’s version ›</button>' : '')
      + '</div>';
  }
  function draftLine(x){
    const c = x.claude; if(!c) return '';
    if(c.status === 'pending') return '<p class="ma-draft-note">Claude is drafting next year’s changes from your note. It shows up here in a few minutes.</p>';
    if(c.status === 'ready') return '<p class="ma-draft-note ready">Claude drafted next year’s changes. <button class="ma-link" data-ma="edit" data-a="'+esc(x.id)+'" data-b="review">Take a look ›</button></p>';
    if(c.status === 'error') return '<p class="ma-draft-note bad">'+esc(c.error)+'</p>';
    return '';
  }

  // ───────────────────────── calendar: month grid + list ─────────────────────────
  function calendarSection(p){
    const vt = '<div class="ma-vt" role="group" aria-label="View">'+[['month','Month'],['list','List']].map(([k, l]) => '<button class="'+(ui.bview === k ? 'on' : '')+'" aria-pressed="'+(ui.bview === k)+'" data-ma="bview" data-a="'+k+'">'+l+'</button>').join('')+'</div>';
    return '<section class="ma-cal" aria-labelledby="maCalTitle"><div class="ma-bh"><h2 id="maCalTitle">Calendar</h2>'+vt+'</div>'
      + (ui.bview === 'list' ? listView(p) : monthView(p))+'</section>';
  }
  function monthView(p){
    const today = T();
    const [y, m] = cursor.split('-').map(Number);
    const first = cursor+'-01', last = E.iso(new Date(y, m, 0));
    const gFrom = E.addDays(first, -E.pd(first).getDay()), gTo = E.addDays(last, 6 - E.pd(last).getDay());
    const days = dayMap(p, gFrom, gTo);
    let h = '<div class="ma-mnav"><button class="ma-navb" data-ma="mshift" data-a="-1" aria-label="Previous month">‹</button><h3>'+E.MONTHS[m-1]+' <span>'+y+'</span></h3><button class="ma-navb" data-ma="mshift" data-a="1" aria-label="Next month">›</button>'
      + (cursor !== today.slice(0,7) ? '<button class="ma-btn quiet" data-ma="mtoday">Today</button>' : '')+'</div>';
    const undated = p.items.filter(x => inTab(x.type) && !x.start && x.month === cursor);
    if(undated.length) h += '<p class="ma-tbd">Also this month, no dates yet: '+undated.map(x => '<button class="ma-link" data-ma="edit" data-a="'+esc(x.id)+'">'+esc(x.name)+'</button>').join(', ')+'</p>';
    h += '<div class="ma-grid" role="grid">'+E.DOW.map(d => '<div class="ma-dow" role="columnheader">'+d+'</div>').join('');
    for(let d = gFrom; d <= gTo; d = E.addDays(d, 1)){
      const list = days[d], dt = E.pd(d), out = d.slice(0,7) !== cursor;
      const runs = [], sends = [];
      p.items.filter(x => inTab(x.type) && x.start && !x.kickoff && x.start <= d && (x.end || x.start) >= d).forEach(x => {
        const cont = d !== x.start && dt.getDay() !== 0;
        runs.push('<span class="ma-ev '+KC(x.type)+(cont ? ' cont' : '')+(x.status !== 'confirmed' ? ' tent' : '')+'" title="'+esc(x.name)+'">'+(cont ? '' : esc(x.name))+'</span>');
      });
      list.filter(e => e.kind === 'send').forEach(({x, s}) => { const ok = E.sendScheduled(x, s.k, s.date);
        sends.push('<span class="ma-sn '+KC(x.type)+(ok ? ' ok' : '')+'" title="'+esc(E.sendName(s)+': '+x.name+(ok ? ' (scheduled)' : ' (not scheduled)'))+'"><b>'+(s.ch === 'email' ? 'Email' : 'Text')+'</b> '+esc(x.name)+'</span>'); });
      const cap = 4, total = runs.length + sends.length;
      const label = E.DOW[dt.getDay()]+' '+E.MONTHS[dt.getMonth()]+' '+dt.getDate()+(runs.length ? ', '+runs.length+' happening' : '')+(sends.length ? ', '+sends.length+' going out' : '');
      h += '<button class="ma-dc'+(out ? ' out' : '')+(d === today ? ' today' : '')+(d === selDay ? ' sel' : '')+'" role="gridcell" aria-label="'+esc(label)+'" data-ma="day" data-a="'+d+'">'
        + '<span class="dn">'+dt.getDate()+'</span><span class="runs">'+runs.slice(0, cap).join('')+'</span>'
        + '<span class="sns">'+sends.slice(0, Math.max(0, cap - Math.min(runs.length, cap))).join('')+'</span>'
        + (total > cap ? '<span class="more">+'+(total - cap)+' more</span>' : '')+'</button>';
    }
    h += '</div><div class="ma-legend"><span><i class="sw k-show"></i>Events</span><span><i class="sw k-se"></i>Service events</span><span><i class="sw k-sale"></i>Sales</span><span><i class="sw dash"></i>Not confirmed</span>'
      + '<span class="note"><span class="d">Email / Text = the day it goes out, ✓ = scheduled. Tap a day for its week.</span><span class="m">Bars = happening. Filled dot = scheduled, open dot = not yet. Tap a day for its week.</span></span></div>';
    if(selDay){
      const wFrom = E.addDays(selDay, -E.pd(selDay).getDay()), wTo = E.addDays(wFrom, 6), a = E.pd(wFrom), b = E.pd(wTo);
      const w = agendaDays(p, wFrom, wTo);
      const title = (wFrom <= today && today <= wTo ? 'This week' : 'Week of '+E.MON[a.getMonth()]+' '+a.getDate())+' <span>'+E.MON[a.getMonth()]+' '+a.getDate()+' – '+(a.getMonth() === b.getMonth() ? '' : E.MON[b.getMonth()]+' ')+b.getDate()+'</span>';
      h += '<div class="ma-week"><div class="ma-weekh"><h4>'+title+'</h4><button class="ma-x" data-ma="dayclose" aria-label="Close week">×</button></div>'+(w.rows || '<p class="ma-empty">Nothing going out or happening that week.</p>')+'</div>';
    }
    return h;
  }
  function listView(p){
    const camps = [...new Set(p.items.map(x => E.campOf(E.monthKey(x))).filter(Boolean))].sort();
    const opts = [['upcoming','Upcoming'], ['all','Full plan']].concat(camps.map(c => [c, E.campLabel(c)]));
    let h = '<div class="ma-chips">'+opts.map(([k, l]) => '<button class="ma-chip'+(ui.list === k ? ' on' : '')+'" data-ma="listview" data-a="'+k+'">'+esc(l)+'</button>').join('')+'</div>';
    const today = T(), r = p.rules;
    let list = p.items.filter(x => inTab(x.type));
    if(ui.list === 'upcoming') list = list.filter(x => E.isLive(x, today)); else if(ui.list !== 'all') list = list.filter(x => E.campOf(E.monthKey(x)) === ui.list);
    list.sort((a, b) => E.cmp(E.sortKey(a), E.sortKey(b)));
    const months = {}; list.forEach(x => { const k = E.monthKey(x) || 'none'; (months[k] = months[k] || []).push(x); });
    const flagCount = {}; E.allFlags(db.state, today, PK()).forEach(f => { if(f.id) flagCount[f.id] = (flagCount[f.id] || 0) + 1; });
    const body = Object.keys(months).sort().map(k => {
      const [y, m] = k.split('-');
      return '<section class="ma-month"><div class="ma-mh"><h3>'+(k === 'none' ? 'No date' : E.MONTHS[+m-1])+'</h3><span>'+(k === 'none' ? '' : y+' · ')+months[k].length+' on the plan</span></div><div class="ma-cards">'
        + months[k].map(x => card(x, r, flagCount[x.id] || 0, today)).join('')+'</div></section>';
    }).join('');
    return h + (body || '<p class="ma-empty">Nothing here. Add something with “Add to plan.”</p>');
  }
  function card(x, r, nFlags, today){
    const a = x.start ? E.pd(x.start) : null, e = x.end ? E.pd(x.end) : a, split = /&/.test(x.datesNote);
    const big = a ? (x.start === (x.end || x.start) ? String(a.getDate()) : a.getMonth() === e.getMonth() ? a.getDate()+(split ? ' & ' : '–')+e.getDate() : String(a.getDate())) : '—';
    const small = a ? (a.getMonth() === e.getMonth() ? E.MON[a.getMonth()] : E.MON[a.getMonth()]+'–'+E.MON[e.getMonth()]) : 'TBD';
    const venue = x.type === 'se' && x.location ? x.location.split('\n')[0].replace(/^[\d/]+\s+[^:]*:\s*/, '').split(',')[0]+(x.location.includes('\n') ? ' + more' : '') : '';
    const who = x.type === 'task' ? '' : [x.radius && x.zip ? x.radius+' mi of '+x.zip : x.zip, x.cities ? '+ '+x.cities : '', x.audience, x.booth ? 'Booth #'+x.booth : '', venue].filter(Boolean).join(' · ');
    const sends = E.sendsFor(x, r).map(s => '<span class="ma-sd '+s.ch+'">'+E.sendName(s)+' '+E.dmd(s.date)+'</span>');
    (x.ch || []).filter(c => c !== 'email' && c !== 'text').forEach(c => sends.push('<span class="ma-sd">'+E.CH[c]+'</span>'));
    if(x.type === 'se' && x.start && !x.sends.length && !E.seTimingSet(r)) sends.unshift('<span class="ma-sd muted">'+r.seEmails+' emails + '+r.seTexts+' texts, timing not set</span>');
    const pill = x.status === 'possible' ? '<span class="ma-pill">Possible</span>' : x.status === 'tbd' ? '<span class="ma-pill tbd">Dates TBD</span>' : '';
    const se = x.linkSE && byId(x.linkSE);
    const past = !E.isLive(x, today), pl = E.prepList(x, r);
    const rc = reviewChip(x, today);
    return '<button class="ma-card t-'+x.type+(past ? ' past' : '')+'" data-ma="edit" data-a="'+esc(x.id)+'">'
      + '<div class="dt"><b'+(big.length > 3 ? ' class="rng"' : '')+'>'+big+'</b><small>'+small+'</small></div>'
      + '<div class="cb"><div class="ctop"><div><div class="cname">'+esc(x.name)+'</div><div class="ctype">'+E.TYPE[x.type]+(x.start && x.datesNote ? ', '+esc(x.datesNote) : '')+'</div></div>'+pill+'</div>'
      + (who ? '<div class="cwho">'+esc(who)+'</div>' : '')+(sends.length ? '<div class="csend">'+sends.join('')+'</div>' : '')
      + (se ? '<div class="clink">Promotes '+esc(se.name)+', '+E.shortRange(se)+'</div>' : '')
      + (!past && pl.length ? '<div class="cprep">Prep '+prepBadge(pl)+'</div>' : '')+(rc ? '<div class="crv">'+rc+'</div>' : '')
      + (nFlags && !past ? '<div class="cflag">'+nFlags+' thing'+(nFlags > 1 ? 's' : '')+' to fix</div>' : '')+'</div></button>';
  }
  function reviewChip(x, today){
    const n = x.review && x.review.next;
    if(n) return '<span class="ma-rvc '+n+'">'+({keep:'Reviewed: back as is', change:'Reviewed: back with changes', drop:'Reviewed: not coming back'})[n]+'</span>';
    if(E.reviewable(x) && E.ended(x, today)) return '<span class="ma-rvc due">Review it</span>';
    return '';
  }

  // ───────────────────────── Command page card ─────────────────────────
  function renderHomeCard(){
    const el = document.getElementById('maHomeCard'); if(!el) return;
    if(!storeUrl()){ el.innerHTML = ''; return; }
    let inner;
    if(!lsGet(LS_KEY) || db.status === 'badkey') inner = '<span class="l"><span class="eb">Marketing</span><b>Connect this device</b><small>Paste your store key once to see what needs you.</small></span>';
    else if(!db.state) inner = '<span class="l"><span class="eb">Marketing</span><b>'+(db.status === 'error' ? 'Couldn’t load the plan' : db.status === 'empty' ? 'Store is empty' : 'Loading…')+'</b></span>';
    else {
      const p = P(), today = T(), fl = E.allFlags(db.state, today, PK());
      const ns = E.reminders(p, today, true).find(x => x.k && x.date >= today);
      const first = fl.length ? E.plain(fl[0].text).replace(/\*/g, '').split(/(?<=[.?])\s/)[0] : 'Every upcoming event has dates, an audience and its sends lined up.';
      inner = '<span class="l"><span class="eb">Marketing</span><b>'+(fl.length ? fl.length+' need'+(fl.length > 1 ? '' : 's')+' you' : 'All clear')+'</b><small>'+esc(first)+'</small></span>'
        + (ns ? '<span class="r"><span class="eb">Next send</span><b>'+esc(E.sendName(ns.send))+' · '+E.dmd(ns.date)+'</b><small>'+esc(p.items.find(y => y.id === ns.id).name)+'</small></span>' : '');
    }
    el.innerHTML = '<button class="ma-home" data-ma="goto">'+inner+'<span class="go" aria-hidden="true">›</span></button>';
  }

  // ───────────────────────── sheets ─────────────────────────
  let sheet = '';
  function ensureSheets(){
    if(document.getElementById('maSheet')) return;
    const d = document.createElement('div');
    d.innerHTML = '<div class="ma-scrim" id="maScrim" data-ma="close"></div>'
      + '<div class="ma-sheet" id="maSheet" role="dialog" aria-modal="true" aria-labelledby="maShTitle"><div class="ma-sh-head"><h2 id="maShTitle"></h2><button class="ma-x" data-ma="close" aria-label="Close">×</button></div><div class="ma-sh-body" id="maShBody"></div><div class="ma-sh-foot" id="maShFoot"></div></div>'
      + '<div class="ma-toast" id="maToast" role="status" aria-live="polite"></div>';
    while(d.firstChild) document.body.appendChild(d.firstChild);
  }
  function openSheet(kind, wide){
    ensureSheets(); sheet = kind;
    const el = document.getElementById('maSheet');
    el.classList.toggle('wide', !!wide); el.classList.add('open');
    document.getElementById('maScrim').classList.add('open');
    document.body.style.overflow = 'hidden';
    SHEETS[kind]();
  }
  function closeSheet(){
    if(!sheet) return;
    sheet = ''; draft = null; rdraft = null; ro = null;
    document.getElementById('maSheet').classList.remove('open', 'wide');
    document.getElementById('maScrim').classList.remove('open');
    document.body.style.overflow = '';
  }
  function sheetParts(title, body, foot){
    document.getElementById('maShTitle').textContent = title;
    const b = document.getElementById('maShBody'), top = b.scrollTop;
    b.innerHTML = body; b.scrollTop = top;
    const f = document.getElementById('maShFoot'); f.innerHTML = foot || ''; f.style.display = foot ? '' : 'none';
  }
  function refreshOpenSheet(){
    if(!sheet) return;
    const focused = document.activeElement && document.getElementById('maSheet').contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if(sheet === 'cal' || sheet === 'ro') SHEETS[sheet]();
    else if(sheet === 'ed' && !focused && draft && editingId){ const live = byId(editingId); if(live && JSON.stringify(live.claude) !== edClaudeSeen) renderEditor(); }
  }
  let tt;
  function toast(msg){ ensureSheets(); const t = document.getElementById('maToast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2800); }

  // ───────────────────────── editor ─────────────────────────
  let draft = null, orig = null, editingId = null, edClaudeSeen = '';
  const f = (label, inner, cls, hint) => '<div class="ma-f'+(cls ? ' '+cls : '')+'"><label>'+label+'</label>'+inner+(hint ? '<div class="ma-hint">'+hint+'</div>' : '')+'</div>';
  function edit(id, toReview){
    editingId = id;
    const src = id ? byId(id) : null;
    if(id && !src){ toast('That item isn’t in this plan anymore.'); return; }
    draft = src ? E.clone(src) : E.newItem({id:'i'+Date.now().toString(36), type:ui.tab === 'all' ? 'show' : ui.tab, ch:['email','text']});
    orig = src ? E.clone(src) : null;
    openSheet('ed');
    if(toReview){ const el = document.getElementById('maEdReview'); if(el) setTimeout(() => el.scrollIntoView({block:'start'}), 40); }
  }
  function renderEditor(){
    const d = draft, p = P(), today = T(), live = editingId ? byId(editingId) : null;
    edClaudeSeen = JSON.stringify(live && live.claude);
    const inp = (k, type, ph) => '<input type="'+(type || 'text')+'" value="'+esc(d[k])+'" placeholder="'+esc(ph || '')+'" data-ma-in="ed" data-k="'+k+'"'+(type === 'number' ? ' inputmode="numeric"' : '')+'>';
    const ta = (k, ph) => '<textarea placeholder="'+esc(ph || '')+'" data-ma-in="ed" data-k="'+k+'">'+esc(d[k])+'</textarea>';
    const seg = (k, opts) => '<div class="ma-seg">'+opts.map(([v, l]) => '<button type="button" class="'+(d[k] === v ? 'on' : '')+'" data-ma="edseg" data-k="'+k+'" data-v="'+v+'">'+l+'</button>').join('')+'</div>';
    const chBtns = '<div class="ma-seg">'+Object.keys(E.CH).map(c => '<button type="button" class="'+(d.ch.includes(c) ? 'on' : '')+'" data-ma="edch" data-a="'+c+'">'+E.CH[c]+'</button>').join('')+'</div>';
    let h = '<div class="ma-sec">What is it?</div>'+f('Type', seg('type', Object.entries(E.TYPE)))
      + '<div class="ma-fgrid" style="margin-top:12px;">'+f('Name', inp('name', 'text', 'e.g. Maricopa Home & Garden Show'), 'full')
      + f('Starts', inp('start', 'date'))+f('Ends', inp('end', 'date'))
      + f('Status', seg('status', [['confirmed','Confirmed'],['possible','Possible'],['tbd','Dates TBD']]), 'full')
      + f('Dates note', inp('datesNote', 'text', 'e.g. 4/23 & 4/27, or 1/26–1/31'), 'full', 'Shows on the plan when dates are split or not final.')
      + (d.start ? '' : f('Month (if no dates yet)', '<input type="month" value="'+esc(d.month)+'" data-ma-in="ed" data-k="month">', 'full'))+'</div>';
    if(d.type !== 'task' && d.type !== 'gift'){
      h += '<div class="ma-sec">Who gets it?</div><div class="ma-fgrid">'+f('Radius (miles)', inp('radius', 'number', '20'))+f('ZIP code(s)', inp('zip', 'text', '86301'))
        + f('Also include these cities', inp('cities', 'text', 'e.g. Kingman, Bullhead City'), 'full')
        + f('Custom list or audience', inp('audience', 'text', 'e.g. ALL clients, Barrett-Jackson tags'), 'full', 'Standing exclusions apply automatically. Change them in Rules.')+'</div>'
        + '<div class="ma-sec">How it goes out</div>'+chBtns
        + '<div class="ma-fgrid" style="margin-top:12px;">'+f('Channel note', inp('chNote', 'text', 'e.g. Direct mail tickets (top 10 clients)'), 'full')+'</div>';
      const auto = E.sendsFor(Object.assign({}, d, {sends:[], relSends:[]}), p.rules);
      h += '<div class="ma-f" style="margin-top:12px;"><label>Send dates</label><div class="ma-hint" style="margin:0 0 8px;">'
        + (auto.length ? 'From your rules: '+auto.map(s => E.sendName(s)+' '+E.dmd(s.date)).join(', ')+'. Add dates below only to override.' : (d.type === 'se' && !E.seTimingSet(p.rules) ? 'Service event timing isn’t set in Rules yet.' : 'Add a start date to get send dates from your rules.'))+'</div>'
        + d.sends.map((s, i) => '<div class="ma-row"><select data-ma-chg="edsend" data-i="'+i+'" data-k="ch"><option value="email"'+(s.ch === 'email' ? ' selected' : '')+'>Email</option><option value="text"'+(s.ch === 'text' ? ' selected' : '')+'>Text</option></select><input type="date" value="'+esc(s.date)+'" data-ma-chg="edsend" data-i="'+i+'" data-k="date"><button class="ma-x" data-ma="edsenddel" data-a="'+i+'" aria-label="Remove">×</button></div>').join('')
        + '<button class="ma-btn" type="button" data-ma="edsendadd">Add a send date</button></div>';
      const seOpts = p.items.filter(x => x.type === 'se' && x.id !== d.id).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      h += '<div class="ma-sec">What to say</div><div class="ma-fgrid">'
        + (d.type === 'show' ? f('Booth #', inp('booth', 'text', 'e.g. 312 (lower concourse)'))+'<div class="ma-f"><label>&nbsp;</label><label class="ma-check"><input type="checkbox"'+(d.needBooth ? ' checked' : '')+' data-ma-chg="edbool" data-k="needBooth">Booth # goes in the marketing</label></div>' : '')
        + f('Promo / raffle', ta('promo', 'e.g. Show the email at the booth to enter the raffle for…'), 'full')
        + f('Notes for the marketer', ta('notes', 'Anything they need to include'), 'full')
        + f('Text script (optional)', ta('script', 'Hey %%firstname%%! …'), 'full');
      if(d.type !== 'se'){
        h += '<div class="ma-f full"><label class="ma-check"><input type="checkbox"'+(d.wantsSE ? ' checked' : '')+' data-ma-chg="edbool" data-k="wantsSE" data-rr="1">Promote a service event in this marketing</label></div>';
        if(d.wantsSE) h += f('Which service event', '<select data-ma-chg="edsel" data-k="linkSE"><option value="">Pick one…</option>'+seOpts.map(s => '<option value="'+esc(s.id)+'"'+(d.linkSE === s.id ? ' selected' : '')+'>'+esc(s.name)+', '+E.shortRange(s)+(s.start ? ' '+s.start.slice(0,4) : '')+'</option>').join('')+'</select>', 'full', seOpts.length ? '' : 'No service events on the plan yet. Add one first.');
      } else h += f('Venue / hotel', ta('location', 'Hotel name, address. One line per day if it moves.'), 'full')+f('Hours', inp('hours', 'text', '9am–5pm'));
      h += '</div>';
    }
    if(d.lastYear && (d.lastYear.liked || d.lastYear.change || d.lastYear.applied || d.lastYear.todo)){
      const ly = d.lastYear;
      h += '<div class="ma-sec">Last year <span class="ma-sec-sub">'+esc(ly.plan)+(ly.when ? ', '+esc(ly.when) : '')+'</span></div><div class="ma-ly">'
        + (ly.liked ? '<p><b>Worked:</b> '+esc(ly.liked)+'</p>' : '')+(ly.change ? '<p><b>You wanted to change:</b> '+esc(ly.change)+'</p>' : '')
        + (ly.applied ? '<p><b>Carried over:</b> '+esc(ly.applied)+'</p>' : '')+(ly.todo ? '<p class="ma-warnline"><b>Still to do:</b> '+esc(ly.todo)+'</p>' : '')+'</div>';
    }
    if(E.reviewable(d)){
      h += '<div class="ma-sec" id="maEdReview">Review <span class="ma-sec-sub">'+(E.ended(d, today) ? 'after the event' : 'opens after it wraps'+(d.end || d.start ? ' on '+E.dmd(d.end || d.start) : ''))+'</span></div>';
      const r = Object.assign({liked:'', change:'', next:''}, d.review);
      if(E.ended(d, today) || r.liked || r.change || r.next){
        h += '<div class="ma-rv"><div class="ma-rv-q"><label>What worked</label><textarea data-ma-in="edrv" data-k="liked" placeholder="e.g. The raffle pulled people to the booth; the text got replies">'+esc(r.liked)+'</textarea></div>'
          + '<div class="ma-rv-q"><label>What to change next year</label><textarea data-ma-in="edrv" data-k="change" placeholder="e.g. Go 25 miles and add Tombstone; raffle the knife of the month instead">'+esc(r.change)+'</textarea></div>'
          + '<div class="ma-rv-q"><label>Next year</label><div class="ma-seg">'+E.NEXT.map(([k, l]) => '<button type="button" class="'+(r.next === k ? 'on' : '')+'" data-ma="edrvnext" data-a="'+k+'">'+l+'</button>').join('')+'</div></div></div>';
        h += claudeBlock(d, live) + nextYearBlock(d);
      } else h += '<p class="ma-hint">Once it’s over you’ll mark what worked, what to change, and whether it comes back next year.</p>';
    }
    const pl = E.prepList(d, p.rules);
    if(pl.length) h += '<div class="ma-sec">Prep checklist <span class="ma-sec-sub">'+E.prepDone(pl)+' of '+pl.length+' done</span></div><div class="ma-prep flat">'+ckLines(pl, d.id, true, true)+'</div>';
    h += '<div class="ma-sec">Reminders</div>'
      + d.rem.map((m, i) => '<div class="ma-row"><input type="date" value="'+esc(m.date || (d.start && m.off != null ? E.addDays(d.start, m.off) : ''))+'" data-ma-chg="edrem" data-i="'+i+'" data-k="date"><input type="text" value="'+esc(m.text)+'" placeholder="e.g. Get hotel info to the marketer" data-ma-in="edremtext" data-i="'+i+'"><button class="ma-x" data-ma="edremdel" data-a="'+i+'" aria-label="Remove">×</button></div>').join('')
      + '<button class="ma-btn" type="button" data-ma="edremadd">Add a reminder</button>';
    const foot = (editingId ? '<button class="ma-btn quiet danger" data-ma="eddel">Delete</button>' : '')+'<span class="spacer"></span><button class="ma-btn" data-ma="close">Cancel</button><button class="ma-btn ma-go" data-ma="edsave">Save</button>';
    sheetParts(editingId ? 'Edit '+(E.TYPE[d.type] || 'item').toLowerCase() : 'Add to plan', h, foot);
  }
  // Claude's draft of next year's changes, read from the live item (it can arrive while the editor is open)
  function claudeBlock(d, live){
    const c = live && live.claude, r = d.review || {};
    const noteNow = (r.change || '').trim();
    if(!c){
      if(E.needsClaude(d) && !E.hasOwnEdits(d)) return '<div class="ma-draft"><p>Save the review and Claude drafts next year’s changes from your note. They show up here in a few minutes.</p></div>';
      return '';
    }
    const changed = c.note !== noteNow && (c.status === 'ready' || c.status === 'pending');
    if(c.status === 'pending') return '<div class="ma-draft"><p><b>Claude is drafting from your note.</b> It usually takes a few minutes; you can close this.</p>'+(changed ? '<p class="ma-hint">You changed the note since. Saving asks Claude again.</p>' : '')+'</div>';
    if(c.status === 'error') return '<div class="ma-draft bad"><p><b>Claude couldn’t draft this one.</b> '+esc(c.error || '')+'</p><button class="ma-btn" data-ma="draftretry" data-a="'+esc(d.id)+'">Try again</button></div>';
    if(c.status === 'ready'){
      const pr = c.proposal || {}, ups = Object.keys(pr.updates || {});
      return '<div class="ma-draft ready"><div class="lab">Claude’s draft</div>'+(pr.summary ? '<p>'+esc(pr.summary)+'</p>' : '')
        + (ups.length ? '<ul>'+ups.map(k => '<li><b>'+E.FIELD_NAME[k]+':</b> '+esc(E.showVal(k, d[k]))+' <span class="arrow">→</span> '+esc(E.showVal(k, pr.updates[k]))+'</li>').join('')+'</ul>' : '<p class="ma-muted">No field changes.</p>')
        + (pr.decision && !r.next ? '<p class="ma-muted">Claude’s call: '+esc({keep:'bring it back as is', change:'bring it back with changes', drop:'don’t bring it back'}[pr.decision])+'.</p>' : '')
        + (pr.unapplied ? '<p class="ma-warnline">Couldn’t apply: '+esc(pr.unapplied)+' It stays pinned to the event as a to-do.</p>' : '')
        + (changed ? '<p class="ma-hint">You changed the note since this draft. Saving asks Claude again.</p>' : '')
        + '<div class="ma-draft-acts"><button class="ma-btn ma-go" data-ma="draftuse" data-a="'+esc(d.id)+'">Use these changes</button><button class="ma-btn" data-ma="draftdismiss" data-a="'+esc(d.id)+'">Dismiss</button></div></div>';
    }
    if(c.status === 'accepted') return '<p class="ma-hint">Claude’s changes are in next year’s version below'+(c.at ? ' ('+E.dmd(c.at.slice(0,10))+')' : '')+'. Edit anything.</p>';
    return '';
  }
  // Next year's version: edit the fields that carry over, right here in the review
  function nextYearBlock(d){
    if(!d.review || d.review.next !== 'change' || d.type === 'task' || d.type === 'gift') return '';
    const e = d.nextEdits || {}, v = k => k in e ? e[k] : d[k];
    const inp = (k, type, ph) => '<input type="'+(type || 'text')+'" value="'+esc(v(k))+'" placeholder="'+esc(ph || '')+'" data-ma-in="ednext" data-k="'+k+'"'+(type === 'number' ? ' inputmode="numeric"' : '')+'>';
    const ta = (k, ph) => '<textarea placeholder="'+esc(ph || '')+'" data-ma-in="ednext" data-k="'+k+'">'+esc(v(k))+'</textarea>';
    const chs = v('ch') || [];
    const diff = E.nextDiff(d);
    return '<div class="ma-next"><div class="ma-next-h"><b>Next year’s version</b><span>'+(diff.length ? diff.length+' change'+(diff.length > 1 ? 's' : '')+' from this year' : 'Same as this year so far')+'</span>'
      + (Object.keys(e).length ? '<button class="ma-link" data-ma="ednextreset">Reset to this year</button>' : '')+'</div>'
      + '<p class="ma-hint">What you set here carries into next year’s plan. Dates, booth #s and checklists start fresh.</p><div class="ma-fgrid">'
      + f('Radius (miles)', inp('radius', 'number'))+f('ZIP code(s)', inp('zip'))+f('Also include these cities', inp('cities'), 'full')+f('Custom list or audience', inp('audience'), 'full')
      + f('Channels', '<div class="ma-seg">'+Object.keys(E.CH).map(c => '<button type="button" class="'+(chs.includes(c) ? 'on' : '')+'" data-ma="ednextch" data-a="'+c+'">'+E.CH[c]+'</button>').join('')+'</div>', 'full')
      + f('Channel note', inp('chNote'), 'full')+f('Promo / raffle', ta('promo'), 'full')+f('Notes for the marketer', ta('notes'), 'full')+f('Text script', ta('script'), 'full')
      + (d.type !== 'se' ? '<div class="ma-f full"><label class="ma-check"><input type="checkbox"'+(v('wantsSE') ? ' checked' : '')+' data-ma-chg="ednextbool" data-k="wantsSE">Promote a service event</label></div>' : '')
      + '</div></div>';
  }
  function saveItem(){
    if(!draft.name.trim()){ toast('Give it a name first.'); return; }
    if(draft.start){ draft.month = ''; if(!draft.end || draft.end < draft.start) draft.end = draft.start; }
    draft.sends = draft.sends.filter(s => s.date);
    const d = E.clone(draft), isNew = !orig, now = nowIso(), pk = PK();
    // only the fields changed here are written, so the calendar check or a Claude draft that landed meanwhile survives
    const changed = isNew ? [] : Object.keys(d).filter(k => k !== 'claude' && JSON.stringify(d[k]) !== JSON.stringify(orig[k]));
    commit(isNew ? 'add '+d.name : 'edit '+d.name, st => {
      const p = st.plans[pk];
      if(isNew){ if(!p.items.some(x => x.id === d.id)) p.items.push(E.clone(d)); }
      else { const x = p.items.find(y => y.id === d.id); if(!x) return; changed.forEach(k => { x[k] = E.clone(d[k]); }); }
      const x = p.items.find(y => y.id === d.id);
      if(x) E.maybeRequestDraft(x, now);
    });
    closeSheet(); toast(isNew ? 'Added to the plan.' : 'Saved.');
  }

  // ───────────────────────── rules ─────────────────────────
  let rdraft = null;
  function renderRules(){
    const r = rdraft;
    const inp = (k, type, ph) => '<input type="'+(type || 'text')+'" value="'+esc(r[k])+'" placeholder="'+esc(ph || '')+'" data-ma-in="rule" data-k="'+k+'">';
    const lines = (k, ph) => '<textarea style="min-height:110px" placeholder="'+esc(ph || '')+'" data-ma-in="rulelines" data-k="'+k+'">'+esc((r[k] || []).join('\n'))+'</textarea>';
    let h = '<div class="ma-sec">Send timing</div><div class="ma-fgrid">'
      + f('Event email: days before', inp('emailDays', 'number'))+f('Event text: days before', inp('textDays', 'number'))
      + f('Service events: emails', inp('seEmails', 'number'))+f('Service events: texts', inp('seTexts', 'number'))
      + f('Service event emails: days before', inp('seEmailDays', 'text', 'e.g. 14, 4'), '', 'One number per email, comma separated.')
      + f('Service event texts: days before', inp('seTextDays', 'text', 'e.g. 7, 3'))+'</div>'
      + '<div class="ma-hint" style="margin-top:8px;">Sales and the All-AZ events email send on their start date.</div>'
      + '<div class="ma-sec">Who never gets marketing</div>'+f('Exclusions, one per line', lines('exclusions'))
      + '<div style="margin-top:12px;">'+f('Service events and sale promos also skip anyone who bought in the last', inp('recentWindow', 'text', '6 months'))+'</div>'
      + '<div class="ma-sec">Standing notes for your marketer</div>'+f('One per line', lines('notes'))
      + '<div class="ma-fgrid" style="margin-top:12px;">'+f('Who handles what, one per line', lines('team'), 'full')
      + f('Facebook group link (goes in every email)', inp('fb'), 'full')
      + f('Contact note', '<textarea data-ma-in="rule" data-k="contact">'+esc(r.contact)+'</textarea>', 'full')
      + f('All-AZ events email instructions', '<textarea style="min-height:110px" data-ma-in="rule" data-k="kickoff">'+esc(r.kickoff)+'</textarea>', 'full')+'</div>'
      + '<div class="ma-sec">Calendar</div>'+f('Calendar to check', inp('calendarId', 'text', 'Blank = your main calendar'), '', 'Purple all-day banners count as shows and service events; lavender multi-day banners count as sales. SC days are skipped. Checked every Monday at 6am.')
      + '<div class="ma-sec">When your marketer gets each campaign</div>'
      + (r.handoffs || []).map((x, i) => '<div class="ma-row"><select data-ma-chg="hset" data-i="'+i+'" data-k="camp" style="flex:0 0 150px">'+campOptions(x.camp)+'</select><input type="date" value="'+esc(x.date)+'" data-ma-chg="hset" data-i="'+i+'" data-k="date"><input type="text" value="'+esc(x.note || x.label || '')+'" placeholder="Label or note" data-ma-in="hnote" data-i="'+i+'"><button class="ma-x" data-ma="hdel" data-a="'+i+'" aria-label="Remove">×</button></div>').join('')
      + '<button class="ma-btn" type="button" data-ma="hadd">Add a hand-off</button>'
      + '<div class="ma-sec">This device</div><p class="ma-hint" style="margin-bottom:10px;">Connected to the marketing store. The key is saved on this device only.</p><button class="ma-btn danger" data-ma="forget">Disconnect this device</button>';
    sheetParts('Standing rules', h, '<span class="spacer"></span><button class="ma-btn" data-ma="close">Cancel</button><button class="ma-btn ma-go" data-ma="rulessave">Save rules</button>');
  }
  function campOptions(sel){
    const years = new Set(); P().items.forEach(x => { const mk = E.monthKey(x); if(mk) years.add(+mk.slice(0,4)); });
    const y0 = Math.min(...years, +T().slice(0,4)), y1 = Math.max(...years, +T().slice(0,4)) + 1;
    let o = '';
    for(let y = y0; y <= y1; y++) ['CI','CII','CIII'].forEach(k => { const c = y+'-'+k; o += '<option value="'+c+'"'+(c === sel ? ' selected' : '')+'>'+E.campLabel(c)+'</option>'; });
    return o;
  }

  // ───────────────────────── calendar sheet ─────────────────────────
  let calShowAll = false;
  function renderCalSheet(){
    const st = db.state, c = st.cal || {}, lr = c.lastRun, today = T(), a = E.calAnalysis(st, today);
    const row = (main, sub, acts) => '<div class="ma-cal-row"><div class="ct">'+main+(sub ? '<small>'+sub+'</small>' : '')+'</div><div class="ca">'+acts+'</div></div>';
    const grp = (label, n, note) => '<div class="ma-cal-grp">'+label+' <span>'+n+(note ? ' · '+note : '')+'</span></div>';
    let h = '<p class="ma-intro">Every Monday at 6am the store reads the purple show and service-event banners and the lavender sale banners on your calendar for the next 12 months. Plan dates move to match, TBD events get locked in, and anything that doesn’t line up lands in Needs you.</p>';
    h += '<p class="ma-status'+(lr && !lr.ok ? ' bad' : '')+'">'+(!lr ? 'Not checked yet.' : lr.ok ? 'Last checked '+new Date(lr.at).toLocaleString([], {weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit'})+' ('+(lr.source === 'weekly' ? 'Monday check' : 'by hand')+'): '+lr.banners+' all-day events read.' : 'The last check ('+E.dmd(lr.at.slice(0,10))+') didn’t finish: '+esc(lr.error)+' Nothing was changed.')+'</p>';
    const log = (c.log || []).filter(l => l.pk === PK() || !l.pk);
    if(log.length){
      h += grp('Updated from your calendar', log.length, 'last 45 days');
      h += log.map(l => row('<b>'+esc(l.name)+'</b> '+(l.fromLabel === l.toLabel ? 'confirmed, '+esc(l.toLabel) : esc(l.fromLabel)+'<span class="arrow">→</span>'+esc(l.toLabel)),
        (l.at ? E.dmd(l.at.slice(0,10))+'. ' : '')+(l.from.status !== l.to.status && l.from.status !== 'confirmed' ? 'Was '+(l.from.status === 'tbd' ? 'dates TBD' : l.from.status)+'. ' : '')+(l.shiftedSends ? 'Custom send dates moved with it. ' : '')+'Calendar: '+esc(l.calTitle),
        '<button data-ma="calundo" data-a="'+esc(l.lid)+'">Undo</button>')).join('');
    }
    if(a){
      if(a.weak.length){ h += grp('Same event?', a.weak.length);
        h += a.weak.map(w => row('<b>'+esc(w.ev.title)+'</b> '+esc(CalCore.range(w.ev.start, w.ev.end))+' on your calendar', 'Plan has '+esc(w.name)+', '+esc(w.planRange),
          '<button class="primary" data-ma="calyes" data-a="'+esc(E.weakKey(w))+'">Same, use calendar dates</button><button data-ma="calno" data-a="'+esc(E.weakKey(w))+'">Different</button>')).join(''); }
      if(a.missing.length){ h += grp('In the plan, not on your calendar', a.missing.length);
        h += a.missing.map(m => row('<b>'+esc(m.name)+'</b> '+esc(CalCore.range(m.start, m.end)), 'Its marketing still goes out unless you change it.',
          '<button data-ma="calstill" data-a="'+esc(m.pk+'|'+m.id+'|'+m.start)+'">Still on</button><button data-ma="calremove" data-a="'+esc(m.pk+'|'+m.id+'|'+m.start)+'">Remove</button>')).join(''); }
      if(a.fresh.length){
        const TYPE_S = {show:'Show', se:'Service event', sale:'Sale'}, list = calShowAll ? a.fresh : a.fresh.slice(0, 8);
        h += grp('On your calendar, not in the plan', a.fresh.length);
        h += list.map(fr => row('<b>'+esc(fr.ev.title)+'</b> '+esc(CalCore.range(fr.ev.start, fr.ev.end)), TYPE_S[fr.ev.kind]+(fr.ev.tentative ? ', marked possible' : '')+(fr.pk !== PK() ? ', goes in the '+esc(fr.pk)+' plan' : ''),
          '<button class="primary" data-ma="caladd" data-a="'+esc(fr.ev.key)+'">Add to plan</button><button data-ma="calignore" data-a="'+esc(fr.ev.key)+'">Not marketing</button>')).join('');
        if(a.fresh.length > 8) h += '<button class="ma-more" data-ma="calmore">'+(calShowAll ? 'Show fewer' : 'Show all '+a.fresh.length)+'</button>';
      }
      if(a.outside.length){
        const last = a.outside[a.outside.length-1].ev.start;
        h += grp('After this plan', a.outside.length, 'through '+E.MONTHS[+last.slice(5,7)-1]+' '+last.slice(0,4));
        h += row(a.outside.length+(a.outside.length === 1 ? ' event on your calendar lands' : ' events on your calendar land')+' after the '+esc(st.active)+' plan ends.', 'Start next year’s plan and they’ll match up as soon as it exists.',
          '<button class="primary" data-ma="rollover">Start '+esc(E.nextLabel(st.active))+' plan</button>');
      }
      if(!log.length && !a.weak.length && !a.missing.length && !a.fresh.length && !a.outside.length) h += '<p class="ma-intro">Your plan and your calendar agree.</p>';
    }
    sheetParts('From your calendar', h, '<span class="spacer"></span><button class="ma-btn'+(db.calBusy ? '' : ' ma-go')+'" data-ma="calcheck"'+(db.calBusy ? ' disabled' : '')+'>'+(db.calBusy ? 'Checking…' : 'Check my calendar now')+'</button>');
  }
  async function calCheck(){
    if(db.calBusy) return;
    db.calBusy = true; render();
    try{
      if(db.queue.length){ await flush(); if(db.queue.length) throw new Error('Your last edit isn’t saved yet. Try again in a moment.'); }
      const o = await call('calcheck');
      db.calBusy = false;
      await loadStore();
      if(!o.ok) toast(o.error === 'calendar' ? 'Calendar check failed: '+o.message : (o.message || 'The calendar check didn’t finish.'));
      else toast(o.result.updated ? o.result.updated+' date'+(o.result.updated > 1 ? 's' : '')+' updated from your calendar.' : 'Checked. Your plan dates already match your calendar.');
    }catch(e){ db.calBusy = false; toast('The calendar check didn’t finish: '+e.message); }
    render();
  }

  // ───────────────────────── next year's plan ─────────────────────────
  let ro = null;
  function openRollover(){
    const st = db.state, label = E.nextLabel(st.active);
    if(st.plans[label]){ ui.plan = label; saveUi(); render(); toast(label+' plan already exists. Switched to it.'); return; }
    ro = {label, from:st.active, decide:{}};
    openSheet('ro', true);
  }
  function roDecision(x){ return ro.decide[x.id] || E.roDefault(x); }
  function renderRollover(){
    const st = db.state, cur = st.plans[ro.from], items = cur.items.slice().sort((a, b) => E.cmp(E.sortKey(a), E.sortKey(b)));
    const groups = {change:[], keep:[], drop:[]};
    items.forEach(x => groups[roDecision(x)].push(x));
    const undrafted = items.filter(x => roDecision(x) !== 'drop' && E.needsClaude(x) && !x.claude && !E.hasOwnEdits(x));
    const pending = items.filter(x => x.claude && x.claude.status === 'pending');
    const seg = x => '<div class="ma-seg sm">'+[['keep','As is'],['change','Changes'],['drop','Drop']].map(([k, l]) => '<button type="button" class="'+(roDecision(x) === k ? 'on' : '')+'" data-ma="roset" data-a="'+esc(x.id)+'" data-b="'+k+'">'+l+'</button>').join('')+'</div>';
    const when = x => E.rangeLabel(x)+(x.start ? ' '+x.start.slice(0,4) : '');
    const tag = x => x.review && x.review.next ? '' : E.reviewable(x) ? (x.claude && x.claude.proposal && x.claude.proposal.decision ? '<span class="ma-rotag">Claude’s call from your notes</span>' : '<span class="ma-rotag">Not reviewed</span>') : x.type === 'psa' && !x.kickoff ? '<span class="ma-rotag">One-time announcement</span>' : '';
    let h = '<p class="ma-intro">Your reviews decide what comes back. Everything that returns keeps its audience, channels, promo and notes (plus the changes you set for next year), gets a fresh checklist, and waits for your calendar to set the dates. Booth #s start blank.</p>';
    h += '<div class="ma-ro-sum"><b>'+groups.keep.length+'</b> back as is · <b>'+groups.change.length+'</b> back with changes · <b>'+groups.drop.length+'</b> not coming back</div>';
    if(undrafted.length || pending.length){
      h += '<div class="ma-ro-claude"><div><b>'+(undrafted.length ? undrafted.length+' event'+(undrafted.length > 1 ? 's have' : ' has')+' notes Claude hasn’t drafted yet' : pending.length+' draft'+(pending.length > 1 ? 's' : '')+' on the way')+'</b>'
        + '<small>'+(undrafted.length ? 'Claude turns each note into next year’s changes. Nothing changes until you tap Use.' : 'Claude is working through your notes. They land here in a few minutes; you can close this and come back.')+'</small></div>'
        + (undrafted.length ? '<button class="ma-btn ma-go" data-ma="roaskall">Ask Claude to draft them</button>' : '')+'</div>';
    }
    if(groups.change.length){
      h += '<div class="ma-ro-grp">Back with changes <span>'+groups.change.length+'</span></div>';
      h += groups.change.map(x => {
        const r = x.review || {}, c = x.claude, diff = E.nextDiff(x);
        let body = r.change ? '<div class="ma-ro-note">“'+esc(r.change)+'”</div>' : '';
        if(diff.length) body += '<div class="ma-ro-out"><div class="lab">Next year</div><ul>'+diff.map(dd => '<li><b>'+dd.label+':</b> '+esc(E.showVal(dd.k, dd.from))+' <span class="arrow">→</span> '+esc(E.showVal(dd.k, dd.to))+'</li>').join('')+'</ul></div>';
        if(c && c.status === 'ready'){
          const pr = c.proposal || {}, ups = Object.keys(pr.updates || {});
          body += '<div class="ma-ro-out claude"><div class="lab">Claude’s draft</div>'+(pr.summary ? '<p>'+esc(pr.summary)+'</p>' : '')
            + (ups.length ? '<ul>'+ups.map(k => '<li><b>'+E.FIELD_NAME[k]+':</b> '+esc(E.showVal(k, x[k]))+' <span class="arrow">→</span> '+esc(E.showVal(k, pr.updates[k]))+'</li>').join('')+'</ul>' : '')
            + (pr.unapplied ? '<p class="ma-warnline">Couldn’t apply: '+esc(pr.unapplied)+'</p>' : '')
            + '<div class="ma-draft-acts"><button class="ma-btn ma-go" data-ma="draftuse" data-a="'+esc(x.id)+'" data-b="'+esc(ro.from)+'">Use these changes</button><button class="ma-btn" data-ma="draftdismiss" data-a="'+esc(x.id)+'" data-b="'+esc(ro.from)+'">Dismiss</button></div></div>';
        } else if(c && c.status === 'pending') body += '<p class="ma-muted small">Claude is drafting from your note…</p>';
        else if(c && c.status === 'error') body += '<p class="ma-warnline small">'+esc(c.error)+' <button class="ma-link" data-ma="draftretry" data-a="'+esc(x.id)+'" data-b="'+esc(ro.from)+'">Try again</button></p>';
        else if(!diff.length && r.change) body += '<p class="ma-muted small">No changes set yet. It comes back as is, with your note pinned to it as a to-do.</p>';
        if(!r.change && !diff.length) body += '<p class="ma-muted small">No change note or edits yet. <button class="ma-link" data-ma="edit" data-a="'+esc(x.id)+'" data-b="review">Set next year’s version</button></p>';
        else body += '<button class="ma-link small" data-ma="edit" data-a="'+esc(x.id)+'" data-b="review">Edit next year’s version</button>';
        return '<div class="ma-ro-row"><div class="ma-ro-top"><div><b>'+esc(x.name)+'</b><small>'+esc(when(x))+'</small>'+tag(x)+'</div>'+seg(x)+'</div>'+body+'</div>';
      }).join('');
    }
    if(groups.keep.length){
      h += '<div class="ma-ro-grp">Back as is <span>'+groups.keep.length+'</span></div>';
      h += groups.keep.map(x => '<div class="ma-ro-row slim"><div class="ma-ro-top"><div><b>'+esc(x.name)+'</b><small>'+esc(when(x))+'</small>'+tag(x)+'</div>'+seg(x)+'</div></div>').join('');
    }
    if(groups.drop.length){
      h += '<div class="ma-ro-grp">Not coming back <span>'+groups.drop.length+'</span></div>';
      h += groups.drop.map(x => { const r = x.review || {}, c = x.claude;
        const why = r.next === 'drop' ? (r.change || r.liked ? 'You said: “'+esc(r.change || r.liked)+'”' : 'You marked it') : c && c.proposal && c.proposal.summary ? 'Claude: '+esc(c.proposal.summary) : '';
        return '<div class="ma-ro-row slim"><div class="ma-ro-top"><div><b>'+esc(x.name)+'</b><small>'+esc(when(x))+'</small>'+tag(x)+(why ? '<small class="why">'+why+'</small>' : '')+'</div>'+seg(x)+'</div></div>'; }).join('');
    }
    sheetParts('Start the '+ro.label+' plan', h, '<span class="spacer"></span><button class="ma-btn" data-ma="close">Cancel</button><button class="ma-btn ma-go" data-ma="rocreate">Create '+esc(ro.label)+' plan</button>');
  }
  function createNextPlan(){
    const label = ro.label, from = ro.from, decisions = E.clone(ro.decide), today = T(), now = nowIso();
    let n = 0, matched = 0;
    commit('start '+label+' plan', st => {
      if(st.plans[label]) return;
      st.plans[label] = E.buildNextPlan(st.plans[from], from, label, Object.assign({}, ...st.plans[from].items.map(x => ({[x.id]:decisions[x.id] || E.roDefault(x)}))));
      st.active = label;
      n = st.plans[label].items.length;
      matched = E.resync(st, today, now).length;
    });
    ui.plan = label; ui.list = 'all'; saveUi();
    closeSheet(); render();
    toast(label+' plan started: '+n+' items.'+(matched ? ' '+matched+' dated from your calendar.' : ''));
  }

  // ───────────────────────── phone menu ─────────────────────────
  function renderMenu(){
    sheetParts('Marketing', '<div class="ma-menu">'
      + '<button data-ma="rules">Rules<small>Send timing, exclusions, marketer notes</small></button>'
      + '<button data-ma="pdf">Export PDF<small>The plan in the shape of your marketer doc</small></button>'
      + '<button data-ma="calsheet">From your calendar<small>What the Monday check changed and asked</small></button>'
      + '<button data-ma="rollover">Start next year’s plan<small>Your reviews decide what comes back</small></button></div>', '');
  }
  const SHEETS = {
    ed: renderEditor,
    ru: renderRules,
    cal: renderCalSheet,
    ro: renderRollover,
    menu: renderMenu
  };

  // ───────────────────────── actions ─────────────────────────
  const pkIdStart = ref => { const [pk, id, start] = String(ref).split('|'); return {pk, id, start}; };
  const ACT = {
    connect(){ const v = (document.getElementById('maKeyIn') || {}).value || ''; if(!v.trim()) return; lsSet(LS_KEY, v.trim()); db.status = 'loading'; loadStore(); },
    reload(){ loadStore(); },
    goto(){ if(typeof showPage === 'function') showPage('marketing', null); },
    tab(el){ ui.tab = el.dataset.a; saveUi(); showAllFlags = false; openRow = ''; render(); },
    flagsmore(){ showAllFlags = !showAllFlags; render(); },
    add(){ closeSheet(); edit(null); },
    edit(el){ closeSheet(); edit(el.dataset.a, el.dataset.b === 'review'); },
    rules(){ closeSheet(); rdraft = E.clone(P().rules); openSheet('ru'); },
    menu(){ openSheet('menu'); },
    pdf(){ closeSheet(); exportPDF(); },
    calsheet(){ closeSheet(); calShowAll = false; openSheet('cal', true); },
    calcheck(){ calCheck(); },
    calmore(){ calShowAll = !calShowAll; renderCalSheet(); },
    rollover(){ closeSheet(); openRollover(); },
    close(){ closeSheet(); },
    dismiss(el){ const key = el.dataset.a, pk = PK(); commit('dismiss', st => { st.plans[pk].dismissed[key] = true; }); toast('Got it. That one won’t come back.'); },
    kick(el){
      const c = el.dataset.a, p = P(), r = p.rules;
      const shows = p.items.filter(x => x.type === 'show' && E.campOf(E.monthKey(x)) === c);
      const firstDue = shows.map(x => E.firstSend(x, r)).filter(Boolean).sort()[0] || (c.slice(0,4)+'-01-05');
      const date = E.addDays(firstDue, -7), id = 'kick'+Date.now().toString(36), pk = PK();
      commit('add All-AZ email', st => { if(!st.plans[pk].items.some(x => x.id === id)) st.plans[pk].items.push(E.newItem({id, type:'psa', kickoff:true, name:'All-AZ events email, '+E.campLabel(c), start:date, end:date, audience:'ALL clients in Arizona', ch:['email']})); });
      edit(id); toast('Added. Set the send date you want.');
    },
    row(el){ openRow = openRow === el.dataset.a ? '' : el.dataset.a; render(); },
    resched(el){ const id = el.dataset.a, key = el.dataset.b; commitItem('rescheduled', id, (x, p) => E.setPrep(x, p.rules, key, true)); toast('Marked rescheduled.'); },
    rvnext(el){ const id = el.dataset.a, v = el.dataset.b, now = nowIso(), today = T();
      commitItem('review', id, x => { x.review = Object.assign({liked:'', change:'', next:''}, x.review, {next:v, at:today}); E.maybeRequestDraft(x, now); }); },
    bview(el){ ui.bview = el.dataset.a; saveUi(); render(); },
    listview(el){ ui.list = el.dataset.a; saveUi(); render(); },
    mshift(el){ const [y, m] = cursor.split('-').map(Number), d = new Date(y, m - 1 + (+el.dataset.a), 1); cursor = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); selDay = ''; render(); },
    mtoday(){ cursor = T().slice(0,7); selDay = ''; render(); },
    day(el){ const d = el.dataset.a; selDay = selDay === d ? '' : d; if(d.slice(0,7) !== cursor && selDay) cursor = d.slice(0,7); openRow = ''; render(); },
    dayclose(){ selDay = ''; render(); },
    // calendar answers
    calyes(el){ const key = el.dataset.a, today = T(), now = nowIso(); let w = null; commit('calendar: same event', st => { w = E.calYes(st, key, today, now) || w; }); toast(w ? 'Linked. '+w.name+' now follows “'+w.ev.title+'.”' : 'Linked.'); },
    calno(el){ const key = el.dataset.a; commit('calendar: different', st => E.calNo(st, key)); },
    calstill(el){ const r = pkIdStart(el.dataset.a); commit('calendar: still on', st => E.calStillOn(st, r.pk, r.id, r.start)); toast('Kept. It won’t ask again unless the dates change.'); },
    calremove(el){ const r = pkIdStart(el.dataset.a), x = E.findItem(db.state, r.pk, r.id); if(!x || !confirm('Remove '+x.name+' from the plan?')) return; commit('remove '+x.name, st => E.removeItem(st, r.pk, r.id)); toast('Removed.'); },
    caladd(el){ const key = el.dataset.a, today = T(), id = 'c'+Date.now().toString(36); let res = null;
      commit('calendar: add', st => { res = E.calAdd(st, key, today, id) || res; });
      if(res && res.pk === PK()){ closeSheet(); edit(res.id); toast('Added. Fill in who gets it.'); } else if(res) toast('Added to the '+res.pk+' plan.'); },
    calignore(el){ const key = el.dataset.a; commit('calendar: not marketing', st => E.calIgnore(st, key)); toast('That one won’t show up here again.'); },
    calundo(el){ const lid = el.dataset.a; commit('calendar: undo', st => E.calUndo(st, lid)); toast('Put back. The calendar won’t move it to those dates again.'); },
    // editor
    edseg(el){ draft[el.dataset.k] = el.dataset.v; renderEditor(); },
    edch(el){ const c = el.dataset.a, i = draft.ch.indexOf(c); i >= 0 ? draft.ch.splice(i, 1) : draft.ch.push(c); renderEditor(); },
    edsendadd(){ draft.sends.push({ch:'email', date:draft.start || T()}); renderEditor(); },
    edsenddel(el){ draft.sends.splice(+el.dataset.a, 1); renderEditor(); },
    edremadd(){ draft.rem.push({date:T(), text:''}); renderEditor(); },
    edremdel(el){ draft.rem.splice(+el.dataset.a, 1); renderEditor(); },
    edresched(el){ E.setPrep(draft, P().rules, el.dataset.b, true); renderEditor(); },
    edrvnext(el){ draft.review = Object.assign({liked:'', change:'', next:''}, draft.review, {next:el.dataset.a, at:T()}); renderEditor(); },
    ednextch(el){ const c = el.dataset.a; draft.nextEdits = draft.nextEdits || {}; const cur = (('ch' in draft.nextEdits) ? draft.nextEdits.ch : draft.ch).slice();
      const i = cur.indexOf(c); i >= 0 ? cur.splice(i, 1) : cur.push(c); draft.nextEdits.ch = cur; renderEditor(); },
    ednextreset(){ draft.nextEdits = null; renderEditor(); },
    edsave(){ saveItem(); },
    eddel(){ const x = byId(editingId); if(!x || !confirm('Delete '+x.name+' from the plan?')) return; const id = editingId, pk = PK(); commit('delete '+x.name, st => E.removeItem(st, pk, id)); closeSheet(); toast('Deleted.'); },
    // Claude drafts (from the editor or the next-year screen)
    draftuse(el){ const id = el.dataset.a, pk = el.dataset.b || PK(), now = nowIso();
      commit('use Claude draft', st => { const x = E.findItem(st, pk, id); if(x) E.acceptDraft(x, now); });
      if(draft && editingId === id){ const live = byId(id); if(live){ draft.nextEdits = E.clone(live.nextEdits); draft.review = E.clone(live.review); orig.nextEdits = E.clone(live.nextEdits); orig.review = E.clone(live.review); } }
      if(sheet === 'ed') renderEditor(); toast('Claude’s changes are in next year’s version.'); },
    draftdismiss(el){ const id = el.dataset.a, pk = el.dataset.b || PK(), now = nowIso(); commit('dismiss Claude draft', st => { const x = E.findItem(st, pk, id); if(x) E.dismissDraft(x, now); }); if(sheet === 'ed') renderEditor(); },
    draftretry(el){ const id = el.dataset.a, pk = el.dataset.b || PK(), now = nowIso(); commit('ask Claude again', st => { const x = E.findItem(st, pk, id); if(x) E.requestDraft(x, now); }); if(sheet === 'ed') renderEditor(); toast('Asked again. It shows up in a few minutes.'); },
    // rules
    hadd(){ rdraft.handoffs = rdraft.handoffs || []; rdraft.handoffs.push({camp:E.campOf(T().slice(0,7)), label:'', date:'', note:''}); renderRules(); },
    hdel(el){ rdraft.handoffs.splice(+el.dataset.a, 1); renderRules(); },
    rulessave(){
      ['exclusions','notes','team'].forEach(k => rdraft[k] = (rdraft[k] || []).map(s => s.trim()).filter(Boolean));
      ['emailDays','textDays','seEmails','seTexts'].forEach(k => rdraft[k] = +rdraft[k] || 0);
      const r = E.clone(rdraft), pk = PK();
      commit('rules', st => { st.plans[pk].rules = E.clone(r); }); closeSheet(); toast('Rules saved.');
    },
    forget(){ if(!confirm('Disconnect this device from the marketing store? You’ll need the key to connect again.')) return; lsDel(LS_KEY); lsDel(LS_CACHE); db.state = null; db.rev = 0; closeSheet(); setStatus('nokey'); render(); },
    // next year
    roset(el){ ro.decide[el.dataset.a] = el.dataset.b; renderRollover(); },
    roaskall(){ const from = ro.from, now = nowIso(), ids = db.state.plans[from].items.filter(x => roDecision(x) !== 'drop' && E.needsClaude(x) && !x.claude && !E.hasOwnEdits(x)).map(x => x.id);
      commit('ask Claude for '+ids.length+' drafts', st => ids.forEach(id => { const x = E.findItem(st, from, id); if(x && !x.claude) E.requestDraft(x, now); }));
      toast('Asked. Drafts land here in a few minutes.'); },
    rocreate(){ createNextPlan(); }
  };
  const CHG = { // change events (selects, checkboxes, blur of textareas)
    plan(el){ if(el.value === '__next'){ el.value = PK(); openRollover(); return; } ui.plan = el.value; saveUi(); selDay = ''; render(); },
    prep(el){ const id = el.dataset.a, key = el.dataset.b, on = el.checked; commitItem(on ? 'ticked' : 'unticked', id, (x, p) => E.setPrep(x, p.rules, key, on)); },
    remdone(el){ const key = el.dataset.a, on = el.checked, pk = PK(); commit('reminder', st => { const p = st.plans[pk]; on ? p.done[key] = true : delete p.done[key]; }); },
    rvtext(el){ const id = el.dataset.a, k = el.dataset.b, v = el.value, now = nowIso(), today = T();
      commitItem('review', id, x => { x.review = Object.assign({liked:'', change:'', next:''}, x.review, {[k]:v, at:today}); E.maybeRequestDraft(x, now); }); },
    edprep(el){ E.setPrep(draft, P().rules, el.dataset.b, el.checked); renderEditor(); },
    edbool(el){ draft[el.dataset.k] = el.checked; if(el.dataset.k === 'wantsSE' && !el.checked) draft.linkSE = ''; renderEditor(); },
    edsel(el){ draft[el.dataset.k] = el.value; },
    edsend(el){ draft.sends[+el.dataset.i][el.dataset.k] = el.value; },
    edrem(el){ draft.rem[+el.dataset.i].date = el.value; delete draft.rem[+el.dataset.i].off; },
    ednextbool(el){ draft.nextEdits = draft.nextEdits || {}; draft.nextEdits[el.dataset.k] = el.checked; renderEditor(); },
    ed(el){ if(['start','end','type'].includes(el.dataset.k)) renderEditor(); },
    hset(el){ const h = rdraft.handoffs[+el.dataset.i]; h[el.dataset.k] = el.value; }
  };
  const IN = { // input events: write to the draft, no re-render (keeps the caret)
    ed(el){ const k = el.dataset.k; let v = el.value; if(k === 'radius') v = v === '' ? '' : +v; draft[k] = v; if(k === 'start' && v && (!draft.end || draft.end < v)) draft.end = v; },
    edrv(el){ draft.review = Object.assign({liked:'', change:'', next:''}, draft.review, {[el.dataset.k]:el.value, at:T()}); },
    ednext(el){ const k = el.dataset.k; let v = el.value; if(k === 'radius') v = v === '' ? '' : +v; draft.nextEdits = draft.nextEdits || {}; draft.nextEdits[k] = v; },
    edremtext(el){ draft.rem[+el.dataset.i].text = el.value; },
    rule(el){ rdraft[el.dataset.k] = el.value; },
    rulelines(el){ rdraft[el.dataset.k] = el.value.split('\n'); },
    hnote(el){ const h = rdraft.handoffs[+el.dataset.i]; h.note = el.value; h.label = ''; }
  };
  function wire(){
    const inScope = el => !!el && !!el.closest('#page-marketing, #maSheet, #maScrim, #maHomeCard');
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-ma]'); if(!inScope(el) || !ACT[el.dataset.ma]) return;
      e.preventDefault(); ACT[el.dataset.ma](el, e);
    });
    document.addEventListener('change', e => { const el = e.target.closest('[data-ma-chg],[data-ma-in]'); if(!inScope(el)) return; const k = el.dataset.maChg || el.dataset.maIn; if(CHG[k]) CHG[k](el, e); });
    document.addEventListener('input', e => { const el = e.target.closest('[data-ma-in]'); if(inScope(el) && IN[el.dataset.maIn]) IN[el.dataset.maIn](el, e); });
    document.addEventListener('keydown', e => {
      if(e.key === 'Escape' && sheet) closeSheet();
      if(e.key === 'Enter' && e.target && e.target.id === 'maKeyIn') ACT.connect();
    });
    document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && active() && Date.now() - db.loadedAt > 30000) loadStore(); });
    window.addEventListener('online', () => { if(db.queue.length) flush(); else loadStore(); });
    let wasPhone = isPhone();
    window.addEventListener('resize', () => { const ph = isPhone(); if(ph !== wasPhone){ wasPhone = ph; render(); } });
    // while a Claude draft or the calendar is in flight, keep the page current
    setInterval(() => {
      if(!db.state || document.visibilityState !== 'visible' || !active() || db.queue.length || db.busy) return;
      const pending = Object.values(db.state.plans).some(p => p.items.some(x => x.claude && x.claude.status === 'pending'));
      if(pending || Date.now() - db.loadedAt > 180000) loadStore();
    }, 30000);
  }

  // ───────────────────────── PDF (same shape as Alan's marketing doc) ─────────────────────────
  const clean = s => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/·/g, '-').replace(/×/g, 'x').replace(/→/g, '->').replace(/[^\x00-\xFF]/g, '');
  function whatLine(x){
    const note = (x.chNote || '').toLowerCase();
    const covered = c => note && note.includes(E.CH[c].toLowerCase().replace(/s$/, '').slice(0, 8));
    const parts = x.ch.filter(c => !covered(c)).map(c => c === 'email' ? 'Email' : c === 'text' ? 'Text Message' : E.CH[c]);
    if(x.chNote) parts.push(x.chNote);
    return parts.join(' & ');
  }
  function whoLine(x){
    const bits = [];
    if(x.audience) bits.push(x.audience);
    if(x.zip) bits.push(x.radius ? 'Clients within a '+x.radius+'-mile radius of '+x.zip : 'Clients in '+x.zip);
    if(x.cities) bits.push('also include '+x.cities);
    return bits.join('; ') || 'TBD';
  }
  function exportPDF(){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('The PDF tool didn’t load. Check your connection and try again.'); return; }
    const p = P(), r = p.rules, pk = PK(), today = T();
    const scope = ui.bview === 'list' && /^\d{4}-C/.test(ui.list) ? ui.list : null;
    const ts = ui.tab === 'all' ? '' : tabShort();
    const items = p.items.filter(x => (!scope || E.campOf(E.monthKey(x)) === scope) && inTab(x.type)).sort((a, b) => E.cmp(E.sortKey(a), E.sortKey(b)));
    const doc = new window.jspdf.jsPDF({unit:'pt', format:'letter'});
    const L = 54, R = 558, W = R - L, BOTTOM = 738;
    let y = 60;
    const need = h => { if(y + h > BOTTOM){ doc.addPage(); y = 60; } };
    const write = (txt, o = {}) => {
      const size = o.size || 10, ind = o.indent || 0, lh = size * 1.32;
      doc.setFont('helvetica', o.bold ? 'bold' : (o.italic ? 'oblique' : 'normal')); doc.setFontSize(size); doc.setTextColor(o.color || '#1c1a15');
      doc.splitTextToSize(clean(txt), W - ind).forEach(l => { need(lh); doc.text(l, L + ind, y); y += lh; });
      y += (o.after == null ? 3 : o.after);
    };
    const labeled = (label, txt, ind) => {
      const size = 10, lh = size * 1.32; ind = ind || 12;
      doc.setFontSize(size); doc.setFont('helvetica', 'bold');
      const lw = doc.getTextWidth(clean(label)+' '), lines = doc.splitTextToSize(clean(txt), W - ind - lw);
      need(lh); doc.setTextColor('#1c1a15'); doc.text(clean(label), L + ind, y); doc.setFont('helvetica', 'normal');
      lines.forEach((l, i) => { if(i) need(lh); doc.text(l, L + ind + (i ? 0 : lw), y); y += lh; });
      y += 2;
    };
    const title = 'Marketing '+pk+(ts ? ' - '+ts : '')+(scope ? ' - '+E.campLabel(scope)+' ('+E.CAMP_SPAN[scope.split('-')[1]]+')' : '');
    write(title, {size:20, bold:true, after:4});
    write('Prepared '+E.md(today)+'/'+today.slice(0,4)+' from the Marketing Advisor', {size:9, color:'#767061', after:14});
    write('NOTE:', {bold:true, size:11, after:4});
    ['Event promotion: email lands '+r.emailDays+' day'+(r.emailDays == 1 ? '' : 's')+' prior, text '+r.textDays+' day'+(r.textDays == 1 ? '' : 's')+' prior.',
      'All service events get '+r.seEmails+' emails and '+r.seTexts+' texts.'+(E.seTimingSet(r) ? ' '+E.seTimingText(r) : '')].concat(r.notes || []).forEach((n, i) => write((i+1)+'. '+n, {indent:10, after:2}));
    y += 4;
    (r.team || []).forEach(t => write(t, {indent:10, after:2}));
    if(r.fb) write('All emails should also include a link to the Facebook Group: '+r.fb, {indent:10, bold:true, after:2});
    if(r.contact) write(r.contact, {indent:10, after:10});
    write('Exclusions for Marketing:', {bold:true, size:11, after:4});
    (r.exclusions || []).forEach(e => write('-  '+e, {indent:10, after:1}));
    if(r.recentWindow) write('-  Service events and sale promos: must not have bought in the last '+r.recentWindow, {indent:10, after:12});
    let curMonth = null;
    items.forEach(x => {
      const mk = E.monthKey(x);
      if(mk !== curMonth){
        curMonth = mk; need(60); y += 8;
        const [yy, mm] = mk ? mk.split('-') : ['', ''];
        write(mk ? E.MONTHS[+mm-1]+' '+yy : 'No date yet', {size:15, bold:true, after:0});
        doc.setDrawColor('#cfc9b8'); doc.line(L, y - 13, R, y - 13); y += 4;
      }
      need(70);
      const tag = x.status === 'possible' ? '  (POSSIBLE, NOT CONFIRMED)' : x.status === 'tbd' ? '  (DATES NOT CONFIRMED)' : '';
      write(x.name + tag, {bold:true, size:11.5, after:3});
      labeled('Date:', (x.start ? E.shortRange(x) : '')+(x.datesNote ? (x.start ? ' ('+x.datesNote+')' : x.datesNote) : (x.start ? '' : 'TBD')));
      if(x.type === 'task'){ y += 8; return; }
      if(x.type !== 'gift'){
        labeled('WHO -', whoLine(x));
        if(x.ch.length) labeled('WHAT -', whatLine(x));
        const sends = E.sendsFor(x, r);
        if(sends.length) labeled('SENDS -', sends.map(s => E.sendName(s)+' '+E.md(s.date)).join(', '));
      }
      const notes = [];
      if(x.booth) notes.push('Booth #'+x.booth+'.');
      if(x.promo) notes.push(x.promo);
      if(x.notes) notes.push(x.notes);
      const se = x.linkSE && byId(x.linkSE);
      if(se) notes.push('Include the link to the '+se.name+' ('+E.shortRange(se)+').');
      if(x.hours) notes.push('Hours: '+x.hours);
      if(notes.length) labeled('NOTES -', notes.join(' '));
      if(x.script) labeled('Text:', '"'+x.script+'"');
      if(x.location) labeled('Location -', x.location.replace(/\n/g, '; '));
      y += 8;
    });
    need(80); y += 8;
    if((ui.tab === 'all' || ui.tab === 'show') && r.kickoff){ write('All-AZ events email (email only)', {size:13, bold:true, after:4}); write(r.kickoff, {after:10}); }
    const hand = (r.handoffs || []).filter(h => !scope || h.camp === scope);
    if(hand.length){
      write('When to send', {size:13, bold:true, after:4});
      hand.forEach(h => write((h.label || E.campLabel(h.camp))+': '+(h.date ? E.MONTHS[+h.date.slice(5,7)-1]+' '+(+h.date.slice(8))+', '+h.date.slice(0,4) : (h.note || 'TBD'))+(h.date && h.note && h.label ? ' ('+h.note+')' : ''), {indent:10, after:2}));
    }
    const pages = doc.getNumberOfPages();
    for(let i = 1; i <= pages; i++){ doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor('#767061'); doc.text(clean(title)+'   |   page '+i+' of '+pages, L, 770); }
    const name = 'Marketing-'+pk.replace(/[^0-9]+/g, '-')+(ts ? '-'+ts.replace(/\s+/g, '-') : '')+(scope ? '-'+E.campLabel(scope).replace(/\s+/g, '-') : '')+'.pdf';
    const a = document.createElement('a'); a.href = URL.createObjectURL(doc.output('blob')); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('PDF saved'+(ts || scope ? ': '+[ts || 'All marketing', scope ? E.campLabel(scope) : ''].filter(Boolean).join(', ') : '')+'.');
  }

  // ───────────────────────── start ─────────────────────────
  function init(){
    ensureSheets(); wire();
    const cached = parse(lsGet(LS_CACHE));
    if(cached && cached.doc && lsGet(LS_KEY)){ try{ db.state = E.migrate(JSON.parse(cached.doc)); db.rev = cached.rev; db.cachedAt = cached.at; }catch(e){ db.state = null; } }
    render();
    loadStore();
    // #marketing (the link in ALMA's morning note) opens this page once the HUB has booted
    if(location.hash === '#marketing'){
      let tries = 0;
      const go = () => { if(typeof showPage === 'function' && typeof S !== 'undefined' && S.weeks) showPage('marketing', null); else if(tries++ < 50) setTimeout(go, 100); };
      go();
    }
  }
  function show(){ render(); if(Date.now() - db.loadedAt > 30000) loadStore(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return {show, render, _db:() => db, _flush:flush, _load:loadStore};
})(MAEngine, CalCore);
