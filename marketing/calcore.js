// Calendar sync core: shared, byte for byte, by the Marketing page (marketing/ui.js),
// the Apps Script store (apps-script/Marketing.gs is built from this file) and the tests.
// Pure JS, no DOM, no network. Copied verbatim from the Marketing Advisor prototype (2026-09-28).
// ==== CALENDAR SYNC CORE (start) ============================================
// Pure JS, no DOM, no network. The Command Center's monthly Apps Script job
// pastes this block verbatim, so keep it self-contained.
// Reads all-day banners from the CUTCO Calendar: purple (Grape, colorId 3) =
// shows + service events, lavender (colorId 1) multi-day = sales. SC days,
// timed shift blocks, recurring events and every other color are ignored.
var CalCore = (function(){
  var SHOW_COLOR = '3', SALE_COLOR = '1';
  var WINDOW = 60;   // a calendar banner can move a plan date by up to 60 days
  var HORIZON = 75;  // "not on your calendar" only matters inside 75 days
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function pd(s){ var p = String(s).slice(0,10).split('-').map(Number); return new Date(p[0], p[1]-1, p[2]); }
  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function add(s, n){ var d = pd(s); d.setDate(d.getDate()+n); return iso(d); }
  function diff(a, b){ return Math.round((pd(b) - pd(a)) / 86400000); }
  function md(s){ var d = pd(s); return (d.getMonth()+1)+'/'+d.getDate(); }
  function range(a, b){
    if(!a) return 'no dates';
    var x = pd(a), y = pd(b || a);
    if(a === (b || a)) return MON[x.getMonth()]+' '+x.getDate();
    if(x.getMonth() === y.getMonth()) return MON[x.getMonth()]+' '+x.getDate()+'–'+y.getDate();
    return MON[x.getMonth()]+' '+x.getDate()+' – '+MON[y.getMonth()]+' '+y.getDate();
  }
  // words that say nothing about WHICH event it is weigh less
  var SYN = {az:'arizona', mhg:'maricopa home garden', hg:'home garden', winterfest:'winter fest', oktoberfest:'oktober fest', xmas:'christmas'};
  var DROP = {the:1, of:1, and:1, a:1, at:1, in:1, on:1, or:1, se:1, service:1, sc:1, shift:1, possible:1, wk:1, week:1, st:1, annual:1};
  var GENERIC = {home:1, garden:1, show:1, expo:1, fair:1, festival:1, fest:1, day:1, art:1, event:1, sale:1, conference:1,
    county:1, spring:1, summer:1, fall:1, holiday:1, christmas:1, market:1, kiosk:1, outdoor:1, living:1, car:1};
  function key(t){ return String(t||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim(); }
  function tokens(t){
    var out = {};
    key(t).split(' ').forEach(function(w){
      (SYN[w] || w).split(' ').forEach(function(v){
        if(v.length > 3 && /s$/.test(v) && !/ss$/.test(v)) v = v.slice(0, -1);
        if(v.length < 2 || DROP[v] || /^\d+$/.test(v)) return;
        out[v] = GENERIC[v] ? 0.3 : 1;
      });
    });
    return out;
  }
  function distinct(tok){ return Object.keys(tok).filter(function(k){ return tok[k] === 1; }); }
  function sim(a, b){
    var inter = 0, wa = 0, wb = 0, shared = false, k;
    for(k in a){ wa += a[k]; if(b[k]){ inter += Math.min(a[k], b[k]); if(a[k] === 1 && b[k] === 1) shared = true; } }
    for(k in b) wb += b[k];
    if(!inter) return {s:0, shared:false};
    var mn = Math.min(wa, wb), jac = inter / (wa + wb - inter), con = inter / mn;
    return {s:Math.max(jac, con * (mn >= 2 ? 0.9 : 0.7)), shared:shared};
  }
  function isSC(t){ return /^([a-z]+ )?s\.?c\.?( days?)?$/.test(key(t)); }
  function isSE(t){ return /(^|[^a-z])se( days?)?($|[^a-z])/i.test(t) || /service events?/i.test(t); }

  // raw: [{title, start:'YYYY-MM-DD', end:'YYYY-MM-DD' (last day, inclusive), color}]
  function classify(raw){
    var out = [];
    (raw || []).forEach(function(e){
      if(!e || !e.title || !e.start) return;
      var t = String(e.title).trim(), c = String(e.color || ''), s = String(e.start).slice(0,10), en = String(e.end || e.start).slice(0,10);
      if(en < s) en = s;
      var kind;
      if(c === SALE_COLOR){ if(en === s) return; kind = 'sale'; }      // one-day lavender = a send marker, not a sale window
      else if(c === SHOW_COLOR){ if(isSC(t)) return; kind = isSE(t) ? 'se' : 'show'; }
      else return;
      out.push({title:t, start:s, end:en, kind:kind, key:key(t), tentative:/possible|\bor\b|\?/i.test(t), days:[s]});
    });
    out.sort(function(a, b){ return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    // same-place service event days a few days apart are one service event (Havasu SE 2/5 + 2/8)
    var merged = [];
    out.forEach(function(e){
      var loc = e.kind === 'se' ? distinct(tokens(e.title)).sort().join(' ') : '';
      var prev = null;
      for(var i = merged.length - 1; i >= 0 && diff(merged[i].start, e.start) <= 10; i--){
        if(merged[i].kind === 'se' && merged[i].loc === loc){ prev = merged[i]; break; }
      }
      if(loc && prev && diff(prev.end, e.start) <= 7){
        prev.end = e.end > prev.end ? e.end : prev.end; prev.days.push(e.start); return;
      }
      e.loc = loc; merged.push(e);
    });
    return merged;
  }

  function planRange(plan){
    var lo = '', hi = '';
    (plan.items || []).forEach(function(it){
      var a = it.start || (it.month ? it.month + '-01' : ''), b = it.end || it.start || (it.month ? it.month + '-28' : '');
      if(a && (!lo || a < lo)) lo = a;
      if(b && (!hi || b > hi)) hi = b;
    });
    if(hi){ var d = pd(hi); hi = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
    return {lo:lo, hi:hi};
  }
  function live(it, today){
    if(it.start) return (it.end || it.start) >= today;
    return !it.month || it.month >= today.slice(0, 7);
  }

  // Compare the calendar with every plan. Pure: returns what WOULD change.
  function analyze(plans, feed, mem, today){
    mem = mem || {};
    var links = mem.links || {}, notSame = mem.notSame || {}, ignore = mem.ignore || {};
    var cands = [], pairs = [];
    Object.keys(plans).forEach(function(pk){
      (plans[pk].items || []).forEach(function(it){
        if(['show','se','sale'].indexOf(it.type) < 0 || !live(it, today)) return;
        cands.push({pk:pk, it:it});
      });
    });
    var evs = (feed || []).filter(function(e){ return e.end >= today; });
    evs.forEach(function(ev, ei){
      var te = tokens(ev.title), locless = ev.kind === 'se' && !distinct(te).length;
      cands.forEach(function(c, ci){
        var it = c.it;
        if(it.type !== ev.kind || notSame[ev.key + '|' + it.id]) return;
        var ref = it.start || (it.month ? it.month + '-15' : '');
        if(!ref) return;
        var dd = Math.abs(diff(ev.start, ref)), linked = links[ev.key] === it.id;
        if(dd > WINDOW && !linked) return;
        var r = sim(te, tokens(it.name)), s = r.s;
        var exact = it.start && ev.start === it.start && ev.end === (it.end || it.start);
        if(exact) s += 0.3; else if(dd <= 3) s += 0.15; else if(dd > 30) s -= 0.15;
        var strong = linked || (s >= 0.6 && r.shared) || (exact && locless);
        var weak = !strong && ((s >= 0.3 && r.shared) || (ev.kind === 'sale' && dd <= 45));
        if(strong || weak) pairs.push({ei:ei, ci:ci, s:s + (strong ? 10 : 0), dd:dd, strong:strong});
      });
    });
    pairs.sort(function(a, b){ return b.s - a.s || a.dd - b.dd; });
    var usedE = {}, usedC = {}, res = {updates:[], same:0, weak:[], fresh:[], missing:[], outside:[]};
    pairs.forEach(function(p){
      if(usedE[p.ei] || usedC[p.ci]) return;
      usedE[p.ei] = usedC[p.ci] = true;
      var ev = evs[p.ei], c = cands[p.ci], it = c.it;
      if(!p.strong){ res.weak.push({ev:ev, pk:c.pk, id:it.id, name:it.name, planRange:range(it.start, it.end)}); return; }
      var to = {start:ev.start, end:ev.end, status:ev.tentative ? 'possible' : 'confirmed',
        datesNote:ev.days.length > 1 ? ev.days.map(md).join(' & ') : ''};
      var from = {start:it.start || '', end:it.end || '', status:it.status, datesNote:it.datesNote || ''};
      if(from.start === to.start && from.end === to.end && from.status === to.status){ res.same++; return; }
      if(plans[c.pk].dismissed && plans[c.pk].dismissed['calundo:' + it.id + ':' + to.start + ':' + to.end]){ res.same++; return; }
      res.updates.push({ev:ev, pk:c.pk, id:it.id, name:it.name, from:from, to:to});
    });
    var ranges = {};
    Object.keys(plans).forEach(function(pk){ ranges[pk] = planRange(plans[pk]); });
    evs.forEach(function(ev, ei){
      if(usedE[ei] || ignore[ev.key]) return;
      var home = Object.keys(plans).filter(function(pk){ return ranges[pk].lo && ev.start >= ranges[pk].lo && ev.start <= ranges[pk].hi; });
      if(home.length) res.fresh.push({ev:ev, pk:home[home.length - 1]});
      else res.outside.push({ev:ev});
    });
    cands.forEach(function(c, ci){
      var it = c.it;
      if(usedC[ci] || it.type === 'sale' || !it.start || it.start < today || diff(today, it.start) > HORIZON) return;
      if(plans[c.pk].dismissed && plans[c.pk].dismissed['notcal:' + it.id + ':' + it.start]) return;
      res.missing.push({pk:c.pk, id:it.id, name:it.name, start:it.start, end:it.end});
    });
    return res;
  }

  // Apply the confident matches. Mutates plans + mem; returns a change log.
  function apply(plans, res, mem){
    mem.links = mem.links || {};
    return res.updates.map(function(u){
      var it = (plans[u.pk].items || []).filter(function(x){ return x.id === u.id; })[0];
      if(!it) return null;
      var shift = u.from.start ? diff(u.from.start, u.to.start) : 0;
      if(shift && it.sends && it.sends.length) it.sends = it.sends.map(function(s){ return {ch:s.ch, date:s.date ? add(s.date, shift) : s.date}; });
      it.start = u.to.start; it.end = u.to.end; it.status = u.to.status; it.month = '';
      if(u.to.datesNote || /\bor\b|tbd|last year|calendar/i.test(it.datesNote || '')) it.datesNote = u.to.datesNote;
      mem.links[u.ev.key] = it.id;
      return {pk:u.pk, id:u.id, name:u.name, calTitle:u.ev.title, from:u.from, to:{start:it.start, end:it.end, status:it.status, datesNote:it.datesNote},
        fromLabel:u.from.start ? range(u.from.start, u.from.end) : 'TBD', toLabel:range(it.start, it.end), shiftedSends:!!(shift && it.sends && it.sends.length)};
    }).filter(Boolean);
  }

  return {classify:classify, analyze:analyze, apply:apply, range:range, key:key, _tokens:tokens, _sim:sim};
})();
// ==== CALENDAR SYNC CORE (end) ==============================================
if (typeof module !== 'undefined' && module.exports) module.exports = CalCore;
