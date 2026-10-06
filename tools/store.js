#!/usr/bin/env node
// The Marketing store from the command line (run on the Mac mini).
//   node tools/store.js ping|status|history|calcheck|digest [--today YYYY-MM-DD]
//   node tools/store.js seed --file plan.json      (only into an empty store)
//   node tools/store.js backup --out file.json     (writes the current plan, mode 600)
//   node tools/store.js restore --rev N            (puts History revision N back as the newest)
// URL: --url, else MA_STORE_URL, else window.MA_STORE_URL in index.html.
// Key: Keychain service cc_marketing_key, account vector-assistant (same item ALMA reads). Never printed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../marketing/engine.js');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
function storeUrl(){
  if(arg('--url')) return arg('--url');
  if(process.env.MA_STORE_URL) return process.env.MA_STORE_URL;
  const m = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').match(/window\.MA_STORE_URL = '([^']*)'/);
  if(!m || !m[1]) throw new Error('No store URL: pass --url or set window.MA_STORE_URL in index.html.');
  return m[1];
}
function key(){
  if(process.env.MA_KEY) return process.env.MA_KEY;
  try{ return execFileSync('security', ['find-generic-password', '-a', 'vector-assistant', '-s', 'cc_marketing_key', '-w'], {encoding:'utf8'}).trim(); }
  catch(e){ throw new Error('Keychain item missing: service cc_marketing_key, account vector-assistant. Add it with: security add-generic-password -U -a vector-assistant -s cc_marketing_key -w'); }
}
async function call(action, extra){
  const res = await fetch(storeUrl(), {method:'POST', body:JSON.stringify(Object.assign({action, key:action === 'ping' ? '' : key()}, extra || {})), redirect:'follow'});
  const text = await res.text();
  let o; try{ o = JSON.parse(text); }catch(e){ throw new Error('The store answered HTTP '+res.status+' with something that isn’t JSON: '+text.slice(0, 120)); }
  return o;
}
function summary(o){
  const st = JSON.parse(o.doc), c = st.cal || {}, lr = c.lastRun;
  const items = Object.fromEntries(Object.entries(st.plans).map(([k, p]) => [k, p.items.length]));
  const pending = E.pendingDrafts(st).length;
  return {rev:o.rev, savedAt:o.savedAt, source:o.source, bytes:o.doc.length, active:st.active, items,
    calendar:lr ? {at:lr.at, ok:lr.ok, updated:lr.updated, error:lr.error || ''} : 'never checked', claudePending:pending};
}
(async () => {
  const cmd = process.argv[2];
  if(cmd === 'ping') return console.log(await call('ping'));
  if(cmd === 'status'){ const o = await call('load'); if(!o.ok) throw new Error(o.message); return console.log(o.rev ? summary(o) : {rev:0, note:'empty store'}); }
  if(cmd === 'history'){ const o = await call('history'); if(!o.ok) throw new Error(o.message); return o.items.forEach(h => console.log('r'+h.rev, h.savedAt, h.source, h.length+'B')); }
  if(cmd === 'seed'){
    const doc = fs.readFileSync(arg('--file'), 'utf8');
    const st = JSON.parse(doc); if(!E.validState(st)) throw new Error('That file is not a marketing plan.');
    const cur = await call('load'); if(!cur.ok) throw new Error(cur.message);
    if(cur.rev && !process.argv.includes('--force')) throw new Error('The store already holds r'+cur.rev+'. Seeding only goes into an empty store.');
    const r = await call('save', {baseRev:cur.rev, doc, hash:E.hash(doc), source:'seed', allowShrink:process.argv.includes('--force')});
    if(!r.ok) throw new Error(r.message || r.error);
    const back = await call('load');
    if(back.rev !== r.rev || E.hash(back.doc) !== E.hash(doc)) throw new Error('Read-back after seeding did not match.');
    return console.log('Seeded r'+r.rev+' and read it back:', summary(back));
  }
  if(cmd === 'backup'){
    const o = await call('load'); if(!o.ok || !o.rev) throw new Error(o.message || 'empty store');
    fs.writeFileSync(arg('--out'), o.doc, {mode:0o600});
    return console.log('Wrote r'+o.rev+' to '+arg('--out'));
  }
  if(cmd === 'calcheck'){ // the same check the Monday trigger and the page's button run
    const r = await call('calcheck');
    if(!r.ok) throw new Error('calendar check failed: '+(r.message || r.error));
    return console.log('r'+r.rev, JSON.stringify(r.result, null, 1));
  }
  if(cmd === 'digest'){ const r = await call('digest', arg('--today') ? {today:arg('--today')} : {}); if(!r.ok) throw new Error(r.message); return console.log(JSON.stringify(r.digest, null, 1)); }
  if(cmd === 'restore'){ const r = await call('restore', {rev:+arg('--rev')}); if(!r.ok) throw new Error(r.message); return console.log('Restored r'+r.restored+' as r'+r.rev+'.'); }
  console.log('usage: node tools/store.js ping|status|history|calcheck|digest|seed --file f|backup --out f|restore --rev N');
})().catch(e => { console.error('store:', e.message); process.exit(1); });
