// Marketing Advisor engine: every rule, send date, flag, checklist, review and plan change.
// Pure JS: no DOM, no network, no clock (callers pass `today` as YYYY-MM-DD).
// One copy serves three places: the Marketing page (marketing/ui.js), the Apps Script
// store (apps-script/Marketing.gs is built from this file by tools/build-gs.js) and the tests.
// Needs CalCore (marketing/calcore.js) loaded first.
var MAEngine = (function (CalCore) {
  'use strict';

  // ───────────────────────── dates ─────────────────────────
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MON = MONTHS.map(m => m.slice(0, 3));
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const iso = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  function pd(s){ if(!s) return null; const [y, m, d] = String(s).slice(0,10).split('-').map(Number); return new Date(y, m-1, d); }
  function addDays(s, n){ const d = pd(s); d.setDate(d.getDate()+n); return iso(d); }
  const daysBetween = (a, b) => Math.round((pd(b) - pd(a)) / 86400000);
  const md = s => { const d = pd(s); return (d.getMonth()+1)+'/'+d.getDate(); };
  const dmd = s => DOW[pd(s).getDay()]+' '+md(s);
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const monthKey = it => it.start ? it.start.slice(0,7) : (it.month || '');
  const sortKey = x => monthKey(x)+'|'+(x.start || '~');
  function campOf(ym){ if(!ym) return ''; const [y, m] = ym.split('-').map(Number); return y+'-'+(m<=4 ? 'CI' : m<=8 ? 'CII' : 'CIII'); }
  const CAMP_NAME = {CI:'Campaign I', CII:'Campaign II', CIII:'Campaign III'};
  const CAMP_SPAN = {CI:'Jan–Apr', CII:'May–Aug', CIII:'Sep–Dec'};
  function campLabel(c){ const [y, k] = c.split('-'); return CAMP_NAME[k]+' '+y; }
  function prevCamp(c){ const [y, k] = c.split('-'); return k==='CI' ? (+y-1)+'-CIII' : k==='CII' ? y+'-CI' : y+'-CII'; }
  function rangeLabel(it){
    if(!it.start){ const mk = monthKey(it); return it.datesNote || (mk ? MONTHS[+mk.slice(5)-1]+', dates TBD' : 'Dates TBD'); }
    const a = pd(it.start), b = pd(it.end || it.start);
    if(it.start === (it.end || it.start)) return MON[a.getMonth()]+' '+a.getDate();
    if(a.getMonth() === b.getMonth()) return MON[a.getMonth()]+' '+a.getDate()+'–'+b.getDate();
    return MON[a.getMonth()]+' '+a.getDate()+' – '+MON[b.getMonth()]+' '+b.getDate();
  }
  function shortRange(it){
    if(!it.start) return it.datesNote || 'TBD';
    const e = it.end || it.start;
    return it.start === e ? md(it.start) : md(it.start)+'–'+md(e);
  }
  function nextLabel(label){ const y = +String(label).slice(0,4); return (y+1)+'–'+String((y+2)%100).padStart(2,'0'); }

  // ───────────────────────── items + rules ─────────────────────────
  const BLANK = {type:'show', name:'', start:'', end:'', month:'', datesNote:'', status:'confirmed', radius:'', zip:'', cities:'',
    audience:'', ch:[], chNote:'', booth:'', needBooth:false, wantsSE:false, linkSE:'', location:'', hours:'', promo:'',
    notes:'', script:'', kickoff:false, sends:[], relSends:[], rem:[], prep:{}, review:{}, lastYear:null, nextEdits:null, claude:null};
  const clone = o => JSON.parse(JSON.stringify(o));
  const newItem = o => Object.assign(clone(BLANK), o);
  const CH = {email:'Email', text:'Text', voice:'Voice drop', mail:'Direct mail tickets', postcards:'Postcards', catalog:'Catalogues'};
  const TYPE = {show:'Show / event', se:'Service event', sale:'Sale / promo', psa:'Announcement', gift:'Client gifts', task:'Task'};
  // No personal data here: this file is public. A plan's own rules live in the store.
  function defaultRules(){
    return {emailDays:3, textDays:1, seEmails:2, seTexts:2, seEmailDays:'14, 4', seTextDays:'7, 3', recentWindow:'6 months', calendarId:'',
      exclusions:['DNC list','Do Not Call tags','Do Not Text tags','Inactive customer status','Disqualified customer status','Lead customer status'],
      notes:[], team:['VA handles all texts.'], contact:'', fb:'', kickoff:'', handoffs:[]};
  }
  const nums = s => String(s == null ? '' : s).split(/[,\s]+/).filter(t => t.trim() !== '').map(Number).filter(n => isFinite(n) && n >= 0);
  const seTimingSet = r => nums(r.seEmailDays).length > 0 || nums(r.seTextDays).length > 0;

  // every dated send an item produces
  function sendsFor(item, rules){
    if(!item.start || item.type === 'gift' || item.type === 'task') return [];
    if((!item.sends || !item.sends.length) && item.relSends && item.relSends.length) return keyed(item.relSends.map(s => ({ch:s.ch, date:addDays(item.start, s.off)})));
    if(item.sends && item.sends.length) return keyed(item.sends.filter(s => s.date).map(s => ({ch:s.ch, date:s.date})));
    const out = [], has = c => (item.ch || []).includes(c);
    if(item.type === 'se'){
      if(!seTimingSet(rules)) return [];
      if(has('email')) nums(rules.seEmailDays).sort((a,b) => b-a).forEach((n, i) => out.push({ch:'email', date:addDays(item.start, -n), tag:i ? 'reminder' : ''}));
      if(has('text')) nums(rules.seTextDays).sort((a,b) => b-a).forEach((n, i) => out.push({ch:'text', date:addDays(item.start, -n), tag:i ? 'last chance' : ''}));
    } else if(item.type === 'sale' || item.kickoff){
      if(has('email')) out.push({ch:'email', date:item.start});
      if(has('text')) out.push({ch:'text', date:item.start});
    } else {
      if(has('email')) out.push({ch:'email', date:addDays(item.start, -(+rules.emailDays || 0))});
      if(has('text')) out.push({ch:'text', date:addDays(item.start, -(+rules.textDays || 0))});
    }
    return keyed(out);
  }
  function keyed(list){ const n = {}; return list.sort((a,b) => cmp(a.date, b.date) || cmp(a.ch, b.ch)).map(s => { n[s.ch] = (n[s.ch] || 0) + 1; return Object.assign(s, {k:s.ch+n[s.ch]}); }); }
  const sendName = s => s.tag === 'reminder' ? 'Reminder email' : s.tag === 'last chance' ? 'Last-chance text' : (s.ch === 'email' ? 'Email' : 'Text');
  function firstSend(item, rules){ const s = sendsFor(item, rules); return s.length ? s[0].date : (item.start || ''); }
  function isLive(item, today){ // still ahead of us (or running now)
    if(item.start) return (item.end || item.start) >= today;
    const mk = monthKey(item); return !mk || mk >= today.slice(0,7);
  }
  const whoShort = x => x.radius && x.zip ? x.radius+' mi of '+x.zip : (x.audience || x.zip || 'Audience TBD');
  function seTimingText(r){
    const e = nums(r.seEmailDays).sort((a,b) => b-a), t = nums(r.seTextDays).sort((a,b) => b-a);
    const part = (arr, second) => arr.map((n, i) => (i ? second+' ' : '')+n+' days prior').join(', ');
    return [e.length ? 'Emails: '+part(e, 'reminder')+'.' : '', t.length ? 'Texts: '+part(t, 'last chance')+'.' : ''].filter(Boolean).join(' ');
  }

  // ───────────────────────── prep checklist (lives on each item) ─────────────────────────
  // item.prep = {list_email:true, email1:'2026-11-10', text1:'2026-11-12', calendly:true, mail:true, …}
  // A send is stored with the date it was scheduled for, so a later date change shows up as "reschedule".
  const PREP_EXTRA = {mail:'Direct mail tickets sent', voice:'Voice drop scheduled', postcards:'Postcards sent', catalog:'Catalogues ordered'};
  function prepList(x, r){
    if(!x || x.type === 'gift' || x.type === 'task') return [];
    const pr = x.prep || {}, out = [], sends = sendsFor(x, r), ch = x.ch || [];
    ['email','text'].filter(c => ch.includes(c)).forEach(c => {
      out.push({key:'list_'+c, label:(c === 'email' ? 'Email' : 'Text')+' list created', done:!!pr['list_'+c], scope:c});
      sends.filter(s => s.ch === c).forEach(s => {
        const v = pr[s.k], stale = typeof v === 'string' && v !== s.date;
        out.push({key:s.k, label:sendName(s)+' scheduled', date:s.date, send:s, done:!!v, stale, was:typeof v === 'string' ? v : '', scope:c});
      });
    });
    if(x.type === 'se') out.push({key:'calendly', label:'Calendly sign-up link set', done:!!pr.calendly, scope:'event'});
    ch.forEach(c => { if(PREP_EXTRA[c]) out.push({key:c, label:PREP_EXTRA[c], done:!!pr[c], scope:'event'}); });
    return out;
  }
  const tasksFor = (l, s) => l.filter(t => t.key === 'list_'+s.ch || t.key === s.k); // a send's own tasks
  const prepDone = l => l.filter(t => t.done && !t.stale).length;
  function sendScheduled(x, k, date){ const v = x && x.prep && x.prep[k]; return !!v && (typeof v !== 'string' || v === date); }
  function setPrep(x, rules, key, on){
    x.prep = x.prep || {};
    const t = prepList(x, rules).find(y => y.key === key);
    if(on) x.prep[key] = t && t.send ? t.date : true; else delete x.prep[key];
  }
  function markHistory(p, today){ // anything already behind us counts as handled
    p.items.forEach(x => {
      x.prep = x.prep || {};
      const past = sendsFor(x, p.rules).filter(s => s.date < today);
      past.forEach(s => { if(!x.prep[s.k]) x.prep[s.k] = s.date; });
      past.forEach(s => { x.prep['list_'+s.ch] = true; });
      if((x.end || x.start) && (x.end || x.start) < today) prepList(x, p.rules).forEach(t => { if(!t.send && !x.prep[t.key]) x.prep[t.key] = true; });
    });
  }

  // ───────────────────────── reviews + next year's version ─────────────────────────
  // item.review = {liked, change, next:'keep'|'change'|'drop', at}
  // item.nextEdits = next year's field values Alan set himself, or accepted from Claude
  // item.claude = {status:'pending'|'ready'|'error'|'accepted'|'dismissed', note, liked, next, requestedAt, proposal, at, error, model}
  const reviewable = x => ['show','se','sale'].includes(x.type);
  const ended = (x, today) => !!x.start && (x.end || x.start) < today;
  const NEXT = [['keep','Bring it back as is'], ['change','Bring it back with changes'], ['drop','Don’t bring it back']];
  const RO_FIELDS = {radius:'number', zip:'string', cities:'string', audience:'string', ch:'channels', chNote:'string', promo:'string', notes:'string', script:'string', wantsSE:'boolean'};
  const FIELD_NAME = {radius:'Radius', zip:'ZIP', cities:'Extra cities', audience:'Audience', ch:'Channels', chNote:'Channel note', promo:'Promo', notes:'Notes', script:'Text script', wantsSE:'Promote a service event'};
  function cleanUpdates(u){ // the only fields a next-year change may touch, each checked for type and size
    const out = {};
    Object.keys(u || {}).forEach(k => {
      const t = RO_FIELDS[k], v = u[k]; if(!t) return;
      if(t === 'number'){ const n = Number(v); if(v !== '' && v !== null && isFinite(n) && n > 0 && n < 500) out[k] = n; }
      else if(t === 'boolean'){ if(typeof v === 'boolean') out[k] = v; }
      else if(t === 'channels'){ if(Array.isArray(v)){ const ch = v.map(String).filter(c => CH[c]); if(ch.length) out[k] = [...new Set(ch)]; } }
      else if(typeof v === 'string') out[k] = v.slice(0, 1200);
    });
    return out;
  }
  const same = (a, b) => JSON.stringify(a == null ? '' : a) === JSON.stringify(b == null ? '' : b);
  function showVal(k, v){
    if(k === 'ch') return (v || []).map(c => CH[c] || c).join(', ') || 'none';
    if(k === 'wantsSE') return v ? 'yes' : 'no';
    if(k === 'radius') return v === '' || v == null ? '—' : v+' mi';
    return v === '' || v == null ? '—' : String(v);
  }
  // next year's edits that actually differ from this year
  function nextDiff(x){
    const e = cleanUpdates(x.nextEdits || {});
    return Object.keys(RO_FIELDS).filter(k => k in e && !same(e[k], x[k])).map(k => ({k, label:FIELD_NAME[k], from:x[k], to:e[k]}));
  }
  const hasOwnEdits = x => nextDiff(x).length > 0;
  function needsClaude(x){
    const r = x.review || {}, change = (r.change || '').trim(), liked = (r.liked || '').trim();
    if(r.next === 'keep' || r.next === 'drop') return false;
    return r.next === 'change' ? !!change : !!(change || liked);
  }
  // Called whenever a review is saved: leaves a request in the store for the mini to draft.
  // Nothing is asked again for the same note, and not at all once Alan edited next year himself.
  function maybeRequestDraft(x, nowIso){
    const r = x.review || {}, c = x.claude;
    if(!needsClaude(x)) return false;
    const note = (r.change || '').trim(), liked = (r.liked || '').trim();
    if(c && c.note === note && c.liked === liked && c.status !== 'error') return false;
    if(!c && hasOwnEdits(x)) return false;
    x.claude = {status:'pending', note, liked, next:r.next || '', requestedAt:nowIso};
    return true;
  }
  function requestDraft(x, nowIso){
    const r = x.review || {};
    x.claude = {status:'pending', note:(r.change || '').trim(), liked:(r.liked || '').trim(), next:r.next || '', requestedAt:nowIso};
  }
  function claudePrompt(x){
    const r = x.review || {};
    const item = {name:x.name, type:TYPE[x.type], when:rangeLabel(x)+(x.start ? ' '+x.start.slice(0,4) : ''), decided:r.next || null,
      radius:x.radius, zip:x.zip, cities:x.cities, audience:x.audience, ch:x.ch, chNote:x.chNote, promo:x.promo, notes:x.notes, script:x.script, wantsSE:!!x.wantsSE,
      liked:(r.liked || '').trim(), change:(r.change || '').trim()};
    return [
      'You are helping a CUTCO sales rep carry one marketing item into next year’s plan. The rep reviewed it after it ran: "liked" is what worked, "change" is what they want different next year, and "decided" is their own call (null if they did not pick one).',
      '1. decision: if "decided" is set, use it. Otherwise choose "keep" (bring back as is), "change" (bring back with changes) or "drop" (do not bring back), based only on the rep’s notes.',
      '2. updates: apply ONLY what the notes ask for, using these fields: radius (number, miles), zip (string, comma-separated ZIPs), cities (string), audience (string), ch (array of "email","text","voice","mail","postcards","catalog"), chNote (string), promo (string), notes (string, instructions for the marketer), script (string, the text message; keep %%firstname%% if present), wantsSE (boolean, promote a service event). Give each changed field its full new value and leave out fields you do not change.',
      '3. Never invent dates, booth numbers, prices, venues or hotel names. Keep the rep’s own wording where you can.',
      '4. unapplied: anything the notes ask for that these fields cannot hold (timing, dates, who sends it, budget), as one short to-do. Otherwise "".',
      '5. summary: one short plain sentence saying what you changed, or why it is not coming back.',
      'Reply with only JSON in this shape: {"decision":"keep|change|drop","updates":{},"summary":"","unapplied":""}',
      '',
      'Item:',
      JSON.stringify(item)
    ].join('\n');
  }
  function parseClaude(raw){
    let s = String(raw || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if(fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if(a < 0 || b < a) throw new Error('Claude’s answer had no JSON in it.');
    const o = JSON.parse(s.slice(a, b+1));
    return {decision:['keep','change','drop'].includes(o.decision) ? o.decision : '', updates:cleanUpdates(o.updates),
      summary:String(o.summary || '').slice(0, 300), unapplied:String(o.unapplied || '').slice(0, 400)};
  }
  // Server side: file Claude's answer on the item, but only if it answers the request that is still open.
  function fileProposal(state, pk, id, requestedAt, raw, model, nowIso){
    const p = state.plans[pk], x = p && p.items.find(y => y.id === id);
    if(!x || !x.claude || x.claude.status !== 'pending' || x.claude.requestedAt !== requestedAt) return 'stale';
    try{
      const prop = parseClaude(raw);
      x.claude = Object.assign({}, x.claude, {status:'ready', proposal:prop, at:nowIso, model:String(model || '').slice(0, 60), error:''});
      return 'ready';
    }catch(e){
      x.claude = Object.assign({}, x.claude, {status:'error', at:nowIso, error:'Claude’s answer didn’t come back in a usable shape. Try again.'});
      return 'error';
    }
  }
  function fileDraftError(state, pk, id, requestedAt, msg, nowIso){
    const p = state.plans[pk], x = p && p.items.find(y => y.id === id);
    if(!x || !x.claude || x.claude.status !== 'pending' || x.claude.requestedAt !== requestedAt) return 'stale';
    x.claude = Object.assign({}, x.claude, {status:'error', at:nowIso, error:String(msg || 'Claude could not be reached.').slice(0, 200)});
    return 'error';
  }
  function pendingDrafts(state){
    const out = [];
    Object.keys(state.plans || {}).forEach(pk => (state.plans[pk].items || []).forEach(x => {
      if(x.claude && x.claude.status === 'pending') out.push({pk, id:x.id, name:x.name, requestedAt:x.claude.requestedAt, prompt:claudePrompt(x)});
    }));
    return out;
  }
  function acceptDraft(x, nowIso){
    const c = x.claude; if(!c || !c.proposal) return;
    x.nextEdits = Object.assign({}, x.nextEdits || {}, cleanUpdates(c.proposal.updates));
    if(c.proposal.decision && !(x.review && x.review.next)) x.review = Object.assign({liked:'', change:'', next:''}, x.review, {next:c.proposal.decision, at:nowIso.slice(0,10)});
    x.claude = Object.assign({}, c, {status:'accepted', at:nowIso});
  }
  function dismissDraft(x, nowIso){ if(x.claude) x.claude = Object.assign({}, x.claude, {status:'dismissed', at:nowIso}); }

  // ───────────────────────── the advisor: what needs a decision or a fix ─────────────────────────
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  const HORIZON = 75; // time-sensitive nudges wait until they matter; structural problems show right away
  const boothNo = b => (String(b || '').match(/\d+/) || [''])[0];
  const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z]/g, '');
  function flags(p, today){
    const r = p.rules, out = [], live = p.items.filter(x => isLive(x, today));
    const soon = d => !d || daysBetween(today, d) <= HORIZON;
    const add = f => { if(!f.types){ const x = f.id && p.items.find(y => y.id === f.id); f.types = x ? [x.type] : []; } if(!p.dismissed[f.key]) out.push(f); };
    live.forEach(it => {
      const due = firstSend(it, r), name = '<b>'+esc(it.name)+'</b>';
      if(it.type === 'task') return;
      if(!it.start){
        if(soon((monthKey(it) || today.slice(0,7))+'-01')) add({key:'dates:'+it.id, sev:'fix', due:(monthKey(it) || '9999')+'-01', id:it.id,
          text: name+(it.datesNote === 'Dates come from your calendar' ? ' isn’t on your calendar yet, so nothing can be scheduled.' : it.datesNote ? ' is on the plan as “'+esc(it.datesNote)+'.” Lock the dates so the sends can be scheduled.' : ' has no dates yet, so nothing can be scheduled.')});
      } else if(it.status === 'possible'){
        if(soon(due)) add({key:'poss:'+it.id, sev:'ask', due, id:it.id, text: name+' is still marked possible. Confirm you’re working it before the first send on '+dmd(due)+'.'});
      } else if(it.status === 'tbd'){
        if(soon(due)) add({key:'tbd:'+it.id, sev:'ask', due, id:it.id, text: name+' dates aren’t confirmed'+(it.datesNote ? ': '+esc(it.datesNote) : '')+'. First send would be '+dmd(due)+'.'});
      }
      if(it.needBooth && !it.booth && soon(due)) add({key:'booth:'+it.id, sev:'fix', due, id:it.id, text: name+' needs a booth # in the marketing, and it’s blank. The email goes out '+(due ? dmd(due) : 'soon')+'.'});
      if(it.type === 'se' && !String(it.location || '').trim() && soon(it.start || due)) add({key:'venue:'+it.id, sev:'fix', due:it.start || due, id:it.id, text: name+' ('+shortRange(it)+') has no venue or hotel yet.'});
      if(it.wantsSE && !it.linkSE) add({key:'selink:'+it.id, sev:'fix', due, id:it.id, text: name+' should promote a service event, but none is linked. Add the service event or turn this off.'});
      if(it.type !== 'se' && it.type !== 'gift' && !it.zip && !it.audience) add({key:'aud:'+it.id, sev:'fix', due, id:it.id, text: name+' has no audience yet.'});
      if(['show','se','sale','psa'].includes(it.type) && !(it.ch || []).length) add({key:'ch:'+it.id, sev:'fix', due, id:it.id, text: name+' has no channels picked.'});
      if(it.type === 'se' && (it.ch || []).length && !it.zip && !it.audience) add({key:'aud:'+it.id, sev:'fix', due:it.start || due, id:it.id, text: name+' has no radius or list yet.'});
      const bn = boothNo(it.booth); // booth reused from another show
      if(bn){
        const other = p.items.find(o => o.id !== it.id && boothNo(o.booth) === bn && (o.start || '') < (it.start || '9999'));
        if(other) add({key:'dupbooth:'+it.id, sev:'ask', due, id:it.id, dismiss:true,
          text: name+' uses Booth #'+bn+', same as '+esc(other.name)+' on '+rangeLabel(other)+(other.start ? ' '+other.start.slice(0,4) : '')+'. New assignment, or carried over?'});
      }
      if(it.start){ // same event on the plan twice
        const twin = live.find(o => o.id !== it.id && o.type === it.type && o.start && norm(o.name) === norm(it.name) && Math.abs(daysBetween(o.start, it.start)) <= 14 && o.start < it.start);
        if(twin) add({key:'twin:'+it.id, sev:'ask', due, id:it.id, dismiss:true, text: name+' appears twice, '+rangeLabel(twin)+' and '+rangeLabel(it)+'. Same show?'});
      }
      const m = ((it.promo || '')+' '+(it.notes || '')).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+raffle/i);
      if(m && it.start){ // "January raffle" on a February event
        const evM = MONTHS[pd(it.start).getMonth()];
        if(m[1].toLowerCase() !== evM.toLowerCase()) add({key:'raffle:'+it.id, sev:'ask', due, id:it.id, dismiss:true, text: name+' runs in '+evM+' but the promo says “'+esc(m[1])+' raffle.” Copied from another event?'});
      }
    });
    // the same area getting 3+ texts inside 5 days, from different items
    const byZip = {};
    live.forEach(x => sendsFor(x, r).filter(s => s.ch === 'text' && s.date >= today).forEach(s =>
      String(x.zip || '').split(/[,\s]+/).filter(z => /^\d{5}$/.test(z)).forEach(z => (byZip[z] = byZip[z] || []).push({date:s.date, id:x.id, name:x.name}))));
    Object.keys(byZip).sort().forEach(z => {
      const list = byZip[z].sort((a,b) => cmp(a.date, b.date));
      for(let i = 0; i < list.length; i++){
        const win = list.filter(t => t.date >= list[i].date && t.date <= addDays(list[i].date, 4));
        const names = [...new Set(win.map(t => t.name))];
        if(win.length >= 3 && new Set(win.map(t => t.id)).size >= 2){
          add({key:'texts:'+z+':'+list[i].date, sev:'ask', due:list[i].date, dismiss:true, types:[...new Set(win.map(t => (p.items.find(y => y.id === t.id) || {}).type))],
            text:'Clients near <b>'+z+'</b> get '+win.length+' texts in 5 days ('+win.map(t => md(t.date)).join(', ')+') from '+names.map(esc).join(' and ')+'. Fold one into another, or keep all '+win.length+'?'});
          i += win.length - 1;
        }
      }
    });
    // prep: sends that moved after they were scheduled, and sends a week out that aren't scheduled
    live.forEach(it => {
      const pl = prepList(it, r), name = '<b>'+esc(it.name)+'</b>';
      const stale = pl.filter(t => t.stale && t.date >= today);
      if(stale.length) add({key:'resched:'+it.id+':'+stale.map(t => t.key+t.date).join(','), sev:'fix', due:stale[0].date, id:it.id,
        text:name+' moved. '+stale.map(t => 'The '+sendName(t.send).toLowerCase()+' you scheduled for '+md(t.was)+' now goes out '+dmd(t.date)).join('; ')+'. Reschedule '+(stale.length > 1 ? 'them' : 'it')+'.'});
      const next = pl.find(t => t.send && !t.done && t.date >= today && daysBetween(today, t.date) <= 7);
      if(next){
        const noList = pl.some(t => t.key === 'list_'+next.send.ch && !t.done);
        add({key:'prep:'+it.id+':'+next.key+':'+next.date, sev:'fix', due:next.date, id:it.id, prep:true,
          text:name+': the '+sendName(next.send).toLowerCase()+' goes out '+dmd(next.date)+' and isn’t scheduled yet.'+(noList ? ' The '+(next.send.ch === 'email' ? 'email' : 'text')+' list isn’t created either.' : '')});
      }
    });
    // one service event promoted by two different events
    live.filter(x => x.type === 'se').forEach(se => {
      const from = live.filter(x => x.linkSE === se.id);
      if(from.length > 1) add({key:'shared:'+se.id, sev:'ask', due:firstSend(from[0], r), id:se.id, dismiss:true, types:['se','show'],
        text:'<b>'+esc(se.name)+'</b> ('+shortRange(se)+') is promoted by '+from.map(x => esc(x.name)).join(' and ')+'. Right, or should one of them point somewhere else?'});
    });
    // service-event send timing isn't written down anywhere
    const liveSE = live.filter(x => x.type === 'se' && x.start);
    if(liveSE.length && !seTimingSet(r)) add({key:'setiming', sev:'fix', due:liveSE[0].start, rules:true, types:['se'],
      text:'Your plan says service events get '+r.seEmails+' emails and '+r.seTexts+' texts, but not when they go out. Set the timing so '+liveSE.length+' service event'+(liveSE.length > 1 ? 's' : '')+' can be scheduled.'});
    // campaign-level: kickoff email + hand-off date
    const camps = {};
    live.forEach(x => { const c = campOf(monthKey(x)); if(c) (camps[c] = camps[c] || []).push(x); });
    Object.keys(camps).sort().forEach(c => {
      const inCamp = p.items.filter(x => campOf(monthKey(x)) === c);
      const shows = inCamp.filter(x => x.type === 'show');
      if(!shows.length) return;
      const firstDue = shows.map(x => firstSend(x, r)).filter(Boolean).sort()[0] || (c.slice(0,4)+'-01-01');
      const prevKick = p.items.find(x => x.kickoff && campOf(monthKey(x)) === prevCamp(c));
      const hasKick = inCamp.some(x => x.kickoff) || (prevKick && prevKick.start >= addDays(firstDue, -45));
      if(!hasKick) add({key:'kick:'+c, sev:'fix', due:addDays(firstDue, -7), kick:c, types:['show'],
        text:'<b>'+campLabel(c)+'</b> has '+shows.length+' event'+(shows.length > 1 ? 's' : '')+' but no All-AZ events email. You send one at the start of every campaign.'});
      if(!(r.handoffs || []).some(h => h.camp === c)) add({key:'hand:'+c, sev:'fix', due:addDays(firstDue, -21), rules:true,
        text:'No date to get <b>'+campLabel(c)+'</b> to your marketer. Its first send is '+dmd(firstDue)+'.'});
    });
    p.items.forEach(it => {
      if(reviewable(it) && ended(it, today) && !(it.review && it.review.next) && daysBetween(it.end || it.start, today) <= 45)
        add({key:'review:'+it.id, sev:'review', due:it.end || it.start, id:it.id, review:true,
          text:'<b>'+esc(it.name)+'</b> wrapped '+dmd(it.end || it.start)+'. Review it while it’s fresh: what worked, what to change, and whether it comes back.'});
      if(it.claude && it.claude.status === 'ready')
        add({key:'draft:'+it.id+':'+it.claude.requestedAt, sev:'review', due:(it.claude.at || '').slice(0,10), id:it.id, review:true, draft:true,
          text:'Claude drafted next year’s changes for <b>'+esc(it.name)+'</b> from your note. Take a look.'});
      if(it.claude && it.claude.status === 'error')
        add({key:'drafterr:'+it.id+':'+it.claude.requestedAt, sev:'ask', due:(it.claude.at || '').slice(0,10), id:it.id, review:true, draft:true,
          text:'Claude couldn’t draft <b>'+esc(it.name)+'</b>: '+esc(it.claude.error || 'no answer')+' Your note still carries over.'});
      if(it.lastYear && it.lastYear.todo && isLive(it, today))
        add({key:'todo:'+it.id, sev:'ask', due:firstSend(it, r) || (monthKey(it) ? monthKey(it)+'-01' : ''), id:it.id, dismiss:true, doneLabel:'Done',
          text:'<b>'+esc(it.name)+'</b>, from last year’s review: “'+esc(it.lastYear.todo)+'”'});
    });
    return out;
  }
  function sortFlags(list){ return list.sort((a,b) => ((a.sev === 'review') - (b.sev === 'review')) || (a.due || '9999').localeCompare(b.due || '9999')); }

  // everything with a date that should nudge Alan
  function reminders(p, today, all){
    const r = p.rules, out = [];
    p.items.forEach(it => {
      if(it.type === 'task' && it.start) out.push({key:'task:'+it.id, date:it.start, text:it.name, sub:'Task', id:it.id, type:'task'});
      sendsFor(it, r).forEach(s => out.push({key:'send:'+it.id+':'+s.k, date:s.date, k:s.k, send:s,
        text:sendName(s)+' goes out: '+it.name, sub:whoShort(it), id:it.id, type:it.type}));
      (it.rem || []).forEach((m, i) => { const date = m.date || (it.start && m.off != null ? addDays(it.start, m.off) : ''); if(date) out.push({key:'rem:'+it.id+':'+i, date, text:m.text || 'Reminder', sub:it.name, id:it.id, type:it.type}); });
    });
    (r.handoffs || []).forEach(h => { if(h.date) out.push({key:'hand:'+h.camp, date:h.date, text:'Send the '+(h.label || campLabel(h.camp))+' plan to your marketer', sub:campLabel(h.camp)+' hand-off', rules:true, type:''}); });
    out.sort((a,b) => a.date.localeCompare(b.date));
    if(all) return out;
    const from = addDays(today, -14), to = addDays(today, 30);
    return out.filter(x => x.date >= from && x.date <= to && !(x.date < today && remDone(p, x)));
  }
  function remDone(p, x){
    if(x.k){ const it = p.items.find(y => y.id === x.id); return sendScheduled(it, x.k, x.date); }
    return !!p.done[x.key];
  }

  // ───────────────────────── calendar ─────────────────────────
  function blankCal(){ return {feed:null, fetchedAt:'', source:'', log:[], logAt:'', ignore:{}, links:{}, notSame:{}, lastRun:null, lastOkAt:''}; }
  function calAnalysis(state, today){ return state.cal && state.cal.feed ? CalCore.analyze(state.plans, state.cal.feed, state.cal, today) : null; }
  let lidN = 0;
  function stampLog(log, nowIso){ return log.map(l => Object.assign(l, {lid:l.lid || nowIso.replace(/\D/g, '').slice(0, 14)+'-'+(lidN++ % 1000)+'-'+l.id, at:nowIso})); }
  function keepLog(state, fresh, today){ // newest first; keep 45 days of changes so an absent week doesn't erase them
    const old = (state.cal.log || []).filter(l => !l.at || daysBetween(l.at.slice(0,10), today) <= 45);
    state.cal.log = fresh.concat(old).slice(0, 80);
  }
  // raw: [{title, start, end (last day, inclusive), color}] from Google Calendar
  function runCalendarSync(state, raw, source, today, nowIso){
    state.cal = Object.assign(blankCal(), state.cal || {});
    const feed = CalCore.classify(raw);
    const a = CalCore.analyze(state.plans, feed, state.cal, today);
    const log = stampLog(CalCore.apply(state.plans, a, state.cal), nowIso);
    keepLog(state, log, today);
    Object.assign(state.cal, {feed, fetchedAt:today, source:source || 'manual', lastOkAt:nowIso});
    if(log.length) state.cal.logAt = today;
    const after = CalCore.analyze(state.plans, feed, state.cal, today);
    state.cal.lastRun = {at:nowIso, ok:true, source:source || 'manual', banners:(raw || []).length, matched:feed.length, updated:log.length,
      weak:after.weak.length, missing:after.missing.length, fresh:after.fresh.length, outside:after.outside.length, error:''};
    return {log, analysis:after};
  }
  function recordCalendarError(state, source, msg, nowIso){
    state.cal = Object.assign(blankCal(), state.cal || {});
    state.cal.lastRun = {at:nowIso, ok:false, source:source || 'manual', error:String(msg || 'unknown error').slice(0, 300)};
  }
  // re-match against the last pull, no network (after a new plan is created)
  function resync(state, today, nowIso){
    if(!state.cal || !state.cal.feed) return [];
    const a = CalCore.analyze(state.plans, state.cal.feed, state.cal, today);
    const log = stampLog(CalCore.apply(state.plans, a, state.cal), nowIso);
    if(log.length){ keepLog(state, log, today); state.cal.logAt = today; }
    return log;
  }
  const findItem = (state, pk, id) => (state.plans[pk] && state.plans[pk].items.find(x => x.id === id)) || null;
  const weakKey = w => w.ev.key+'|'+w.id;
  function calUndo(state, lid){
    const i = (state.cal.log || []).findIndex(l => l.lid === lid); if(i < 0) return false;
    const l = state.cal.log[i], it = findItem(state, l.pk, l.id);
    if(it){
      const shift = l.from.start ? daysBetween(l.to.start, l.from.start) : 0;
      if(l.shiftedSends && shift) it.sends = it.sends.map(x => ({ch:x.ch, date:x.date ? addDays(x.date, shift) : x.date}));
      Object.assign(it, {start:l.from.start, end:l.from.end, status:l.from.status, datesNote:l.from.datesNote});
      if(!it.start && !it.month) it.month = l.to.start.slice(0,7);
      state.plans[l.pk].dismissed['calundo:'+l.id+':'+l.to.start+':'+l.to.end] = true;
    }
    state.cal.log.splice(i, 1);
    return true;
  }
  function calYes(state, key, today, nowIso){
    const a = calAnalysis(state, today), w = a && a.weak.find(x => weakKey(x) === key); if(!w) return null;
    const it = findItem(state, w.pk, w.id); if(!it) return null;
    const u = {ev:w.ev, pk:w.pk, id:w.id, name:w.name,
      from:{start:it.start || '', end:it.end || '', status:it.status, datesNote:it.datesNote || ''},
      to:{start:w.ev.start, end:w.ev.end, status:w.ev.tentative ? 'possible' : 'confirmed', datesNote:w.ev.days.length > 1 ? w.ev.days.map(md).join(' & ') : ''}};
    const log = stampLog(CalCore.apply(state.plans, {updates:[u]}, state.cal), nowIso);
    keepLog(state, log, today);
    return w;
  }
  function calNo(state, key){ state.cal.notSame[key] = true; }
  function calStillOn(state, pk, id, start){ state.plans[pk].dismissed['notcal:'+id+':'+start] = true; }
  function removeItem(state, pk, id){
    const p = state.plans[pk]; if(!p) return;
    p.items = p.items.filter(x => x.id !== id); p.items.forEach(x => { if(x.linkSE === id) x.linkSE = ''; });
  }
  function calAdd(state, evKey, today, newId){
    const a = calAnalysis(state, today), f = a && a.fresh.find(x => x.ev.key === evKey); if(!f) return null;
    const ev = f.ev;
    const item = newItem({id:newId, type:ev.kind, name:ev.title.replace(/\s*-\s*$/, '').trim(), start:ev.start, end:ev.end,
      status:ev.tentative ? 'possible' : 'confirmed', datesNote:ev.days.length > 1 ? ev.days.map(md).join(' & ') : '', ch:['email','text']});
    state.plans[f.pk].items.push(item); state.cal.links[ev.key] = newId;
    return {pk:f.pk, id:newId};
  }
  function calIgnore(state, evKey){ state.cal.ignore[evKey] = true; }
  // the calendar's open questions, as Needs-you flags for the active plan's page
  function calendarFlags(state, today, pk){
    const out = [], a = calAnalysis(state, today), c = state.cal || {}, act = pk || state.active;
    const lr = c.lastRun;
    if(lr && !lr.ok) out.push({key:'calerr:'+lr.at, sev:'fix', due:today, cal:'error', types:['show','se','sale'],
      text:'The calendar check on '+dmd(lr.at.slice(0,10))+' didn’t finish: '+esc(lr.error)+' Nothing was changed.'});
    else if(c.lastOkAt && daysBetween(c.lastOkAt.slice(0,10), today) > 8) out.push({key:'calstale:'+c.lastOkAt.slice(0,10), sev:'fix', due:today, cal:'error', types:['show','se','sale'],
      text:'Your calendar hasn’t been checked since '+dmd(c.lastOkAt.slice(0,10))+'. The weekly check should run every Monday.'});
    if(!a) return out;
    a.weak.forEach(w => { out.push({key:'calweak:'+weakKey(w), sev:'ask', due:w.ev.start, cal:'weak', ref:weakKey(w), types:[w.ev.kind], pk:w.pk, id:w.id,
      text:'Same event? Your calendar has <b>'+esc(w.ev.title)+'</b> '+esc(CalCore.range(w.ev.start, w.ev.end))+'. The plan has <b>'+esc(w.name)+'</b>, '+esc(w.planRange)+'.'}); });
    a.missing.forEach(m => { const it = findItem(state, m.pk, m.id); out.push({key:'calmiss:'+m.pk+':'+m.id+':'+m.start, sev:'ask', due:m.start, cal:'missing', ref:m.pk+'|'+m.id+'|'+m.start, types:[it ? it.type : 'show'], pk:m.pk, id:m.id,
      text:'<b>'+esc(m.name)+'</b> ('+esc(CalCore.range(m.start, m.end))+') is in the plan but not on your calendar. Its marketing still goes out unless you change it.'}); });
    const fresh = a.fresh.filter(f => f.pk === act);
    if(fresh.length) out.push({key:'calfresh:'+fresh.length, sev:'ask', due:fresh[0].ev.start, cal:'fresh', types:[...new Set(fresh.map(f => f.ev.kind))],
      text:fresh.length+' event'+(fresh.length > 1 ? 's' : '')+' on your calendar '+(fresh.length > 1 ? 'aren’t' : 'isn’t')+' in the plan: '+fresh.slice(0, 3).map(f => '<b>'+esc(f.ev.title)+'</b>').join(', ')+(fresh.length > 3 ? ' and '+(fresh.length - 3)+' more' : '')+'.'});
    if(a.outside.length){
      const last = a.outside[a.outside.length-1].ev.start;
      out.push({key:'caloutside:'+a.outside.length, sev:'ask', due:a.outside[0].ev.start, cal:'outside', types:[...new Set(a.outside.map(o => o.ev.kind))],
        text:a.outside.length+(a.outside.length === 1 ? ' event on your calendar lands' : ' events on your calendar land')+' after the '+esc(act)+' plan ends (through '+MONTHS[+last.slice(5,7)-1]+' '+last.slice(0,4)+'). Start next year’s plan when you’re ready.'});
    }
    return out;
  }
  // flags for the active plan: plan rules + calendar questions, sorted
  function allFlags(state, today, pk){
    pk = pk || state.active;
    const p = state.plans[pk];
    const cal = calendarFlags(state, today, pk).filter(f => !p.dismissed[f.key]);
    return sortFlags(flags(p, today).concat(cal));
  }

  // ───────────────────────── next year's plan ─────────────────────────
  function roDefault(x){
    if(x.review && x.review.next) return x.review.next;
    if(x.claude && x.claude.status === 'accepted' && x.claude.proposal && x.claude.proposal.decision) return x.claude.proposal.decision;
    if(x.type === 'psa' && !x.kickoff) return 'drop';
    if(hasOwnEdits(x)) return 'change';
    return 'keep';
  }
  // Pure: returns the new plan. decisions maps item id → keep|change|drop (missing ids use roDefault).
  function buildNextPlan(cur, curLabel, label, decisions){
    const yr = +label.slice(0,4), decision = {};
    cur.items.forEach(x => decision[x.id] = (decisions && decisions[x.id]) || roDefault(x));
    const idMap = {}; cur.items.forEach(x => { if(decision[x.id] !== 'drop') idMap[x.id] = x.id.replace(/-?\d{4}$/, '')+'-'+yr; });
    const used = {}; Object.keys(idMap).forEach(k => { let v = idMap[k], n = 2; while(used[v]) v = idMap[k]+'-'+(n++); used[v] = 1; idMap[k] = v; });
    const DATED = ['show','se','sale'];
    const items = cur.items.filter(x => decision[x.id] !== 'drop').map(x => {
      const y = clone(x), r = x.review || {}, c = x.claude, d = decision[x.id];
      y.id = idMap[x.id];
      if(x.start || x.month){ const mk = (x.start || x.month).slice(0,7).split('-'); y.month = (+mk[0]+1)+'-'+mk[1]; }
      const ref = x.start;
      y.start = ''; y.end = ''; y.status = DATED.includes(x.type) ? 'tbd' : x.status;
      y.datesNote = DATED.includes(x.type) ? 'Dates come from your calendar' : '';
      if(!DATED.includes(x.type) && x.start){ y.start = addDays(x.start, 364); y.end = x.end ? addDays(x.end, 364) : ''; y.month = ''; y.status = x.status; }
      y.booth = '';
      y.linkSE = x.linkSE ? (idMap[x.linkSE] || '') : '';
      y.relSends = ref && x.sends && x.sends.length ? x.sends.filter(s => s.date).map(s => ({ch:s.ch, off:daysBetween(ref, s.date)})) : (x.relSends || []);
      y.sends = [];
      y.rem = (x.rem || []).map(m => ref && m.date ? {off:daysBetween(ref, m.date), text:m.text} : m.off != null ? {off:m.off, text:m.text} : {date:m.date ? addDays(m.date, 364) : '', text:m.text});
      y.prep = {}; y.review = {}; y.nextEdits = null; y.claude = null;
      const diff = d === 'change' ? nextDiff(x) : [];
      if(diff.length) Object.assign(y, cleanUpdates(x.nextEdits));
      const accepted = c && c.status === 'accepted' && c.proposal;
      y.lastYear = {plan:curLabel, when:rangeLabel(x)+(x.start ? ' '+x.start.slice(0,4) : ''), liked:r.liked || '', change:r.change || '',
        applied:diff.length ? diff.map(f => f.label+': '+showVal(f.k, f.from)+' → '+showVal(f.k, f.to)).join('; ') : '',
        todo:d === 'change' ? (accepted ? (c.proposal.unapplied || '') : (diff.length ? '' : (r.change || ''))) : ''};
      return y;
    });
    const rules = clone(cur.rules);
    rules.handoffs = (rules.handoffs || []).map(h => ({camp:(+h.camp.slice(0,4)+1)+h.camp.slice(4), label:h.label, note:h.note, date:h.date ? (+h.date.slice(0,4)+1)+h.date.slice(4) : ''}));
    const dropped = cur.items.filter(x => decision[x.id] === 'drop').map(x => ({name:x.name, when:rangeLabel(x), why:(x.review && (x.review.change || x.review.liked)) || ''}));
    return {rules, items, dismissed:{}, done:{}, from:curLabel, dropped};
  }

  // ───────────────────────── state ─────────────────────────
  const VERSION = 7;
  function fillItem(x){ Object.keys(BLANK).forEach(k => { if(x[k] === undefined) x[k] = clone(BLANK[k]); }); return x; }
  function migrate(state){
    state.v = VERSION;
    state.cal = Object.assign(blankCal(), state.cal || {});
    delete state.ui; // view settings live on each device, not in the shared plan
    Object.keys(state.plans || {}).forEach(pk => {
      const p = state.plans[pk];
      p.rules = Object.assign(defaultRules(), p.rules || {});
      p.items = (p.items || []).map(fillItem);
      p.dismissed = p.dismissed || {}; p.done = p.done || {};
    });
    return state;
  }
  // a brand-new store from one plan: everything already behind `today` counts as handled
  function freshState(plan, label, today){
    const state = migrate({active:label, plans:{[label]:plan}, cal:blankCal()});
    const p = state.plans[label];
    reminders(p, today, true).forEach(r => { if(r.date < today && !r.k) p.done[r.key] = true; });
    markHistory(p, today);
    return state;
  }
  function validState(state){
    return !!(state && typeof state === 'object' && state.plans && typeof state.plans === 'object' && state.active && state.plans[state.active] && Array.isArray(state.plans[state.active].items));
  }
  // FNV-1a over the saved text, so the page and the store can prove they hold the same bytes
  function hash(str){
    let h = 0x811c9dc5; const s = String(str);
    for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return s.length+':'+h.toString(16).padStart(8, '0');
  }

  // ───────────────────────── the morning digest (ALMA reads this) ─────────────────────────
  function plain(html){
    return String(html || '').replace(/<b>/g, '*').replace(/<\/b>/g, '*').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  // Every plan counts: in December the old plan still has January's shows while the new one fills in.
  function digest(state, today){
    const tomorrow = addDays(today, 1), sends = [], rems = [], fixes = [], draftsReady = [];
    let reviewsDue = 0, needsYou = 0;
    Object.keys(state.plans || {}).sort().forEach(pk => {
      const p = state.plans[pk];
      const all = reminders(p, today, true).filter(x => x.date === today || x.date === tomorrow);
      const covered = {};
      all.filter(x => x.k && !remDone(p, x)).forEach(x => { covered[x.id] = true; sends.push({plan:pk, date:x.date, when:x.date === today ? 'today' : 'tomorrow', text:x.text, sub:x.sub, id:x.id}); });
      all.filter(x => !x.k && !remDone(p, x)).forEach(x => rems.push({plan:pk, date:x.date, when:x.date === today ? 'today' : 'tomorrow', text:x.text, sub:x.sub}));
      const fl = allFlags(state, today, pk).filter(f => !f.cal || pk === state.active);
      fl.filter(f => f.sev === 'fix' && f.cal !== 'error' && (f.due || '9999') <= addDays(today, 7) && !(f.prep && covered[f.id]))
        .forEach(f => fixes.push({plan:pk, key:f.key, due:f.due, text:plain(f.text)}));
      p.items.filter(x => x.claude && x.claude.status === 'ready').forEach(x => draftsReady.push(x.name));
      reviewsDue += fl.filter(f => f.key.startsWith('review:')).length;
      needsYou += fl.length;
    });
    const c = state.cal || {}, lr = c.lastRun;
    const stale = !c.lastOkAt || daysBetween(c.lastOkAt.slice(0,10), today) > 8;
    const questions = calendarFlags(state, today, state.active).filter(f => f.cal !== 'error').length;
    return {today, plan:state.active, sends, reminders:rems, fixes: fixes.sort((a,b) => (a.due || '').localeCompare(b.due || '')),
      calendar:{lastRunAt:lr ? lr.at : '', ok:lr ? !!lr.ok : false, error:lr && !lr.ok ? lr.error : '', lastOkAt:c.lastOkAt || '', stale,
        updated:(c.log || []).filter(l => l.at && daysBetween(l.at.slice(0,10), today) <= 1).map(l => ({name:l.name, from:l.fromLabel, to:l.toLabel})),
        questions},
      draftsReady, reviewsDue, needsYou};
  }

  return {
    // dates + labels
    MONTHS, MON, DOW, iso, pd, addDays, daysBetween, md, dmd, cmp, monthKey, sortKey, campOf, campLabel, prevCamp, CAMP_SPAN,
    rangeLabel, shortRange, nextLabel,
    // items + rules
    BLANK, CH, TYPE, newItem, clone, defaultRules, nums, seTimingSet, seTimingText, sendsFor, sendName, firstSend, isLive, whoShort,
    // prep
    PREP_EXTRA, prepList, tasksFor, prepDone, sendScheduled, setPrep, markHistory,
    // reviews + drafts
    reviewable, ended, NEXT, RO_FIELDS, FIELD_NAME, cleanUpdates, showVal, nextDiff, hasOwnEdits, needsClaude, maybeRequestDraft, requestDraft,
    claudePrompt, parseClaude, fileProposal, fileDraftError, pendingDrafts, acceptDraft, dismissDraft,
    // advisor
    esc, flags, sortFlags, allFlags, reminders, remDone, HORIZON,
    // calendar
    blankCal, calAnalysis, runCalendarSync, recordCalendarError, resync, calUndo, calYes, calNo, calStillOn, calAdd, calIgnore, removeItem, calendarFlags, weakKey, findItem,
    // next year
    roDefault, buildNextPlan,
    // state
    VERSION, migrate, freshState, validState, hash, plain, digest
  };
})(typeof CalCore !== 'undefined' ? CalCore : require('./calcore.js'));
if (typeof module !== 'undefined' && module.exports) module.exports = MAEngine;
