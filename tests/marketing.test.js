// Marketing Advisor tests: rules, calendar matching, the store's safety, Claude drafts, next year.
// Run: node --test tests/     (no dependencies; the store runs on tools/gas-sim.js)
// The plan here is made up. This repo is public: real plans live only in the store.
process.env.TZ = 'America/Phoenix';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const CalCore = require('../marketing/calcore.js');
const E = require('../marketing/engine.js');
const { createStore } = require('../tools/gas-sim');
const { build, OUT } = require('../tools/build-gs');

const TODAY = '2026-10-01';
const it = E.newItem;
function demoPlan(){
  const rules = Object.assign(E.defaultRules(), {handoffs:[{camp:'2026-CIII', label:'Fall', date:'2026-09-01', note:''}]});
  return {rules, dismissed:{}, done:{}, items:[
    it({id:'kick-fa26', type:'psa', kickoff:true, name:'All-AZ fall events email', start:'2026-09-01', end:'2026-09-01', audience:'ALL clients in Arizona', ch:['email']}),
    it({id:'pine26', name:'Pinecrest Car Show', start:'2026-09-25', end:'2026-09-27', radius:20, zip:'85935', ch:['email','text'], wantsSE:true, linkSE:'se-pine26'}),
    it({id:'se-pine26', type:'se', name:'Pinecrest Service Event', start:'2026-09-28', end:'2026-09-28', radius:20, zip:'85935', ch:['email','text'], location:'Sample Hotel, 1 Main St'}),
    it({id:'expo26', name:'Desert Home Expo', start:'2026-10-09', end:'2026-10-11', radius:10, zip:'85260', ch:['email','text'], needBooth:true}),
    it({id:'sale26', type:'sale', name:'Fall sale', start:'2026-10-13', end:'2026-10-29', audience:'Sale list', ch:['email','text']}),
    it({id:'lake26', name:'Lakeside Fair', month:'2026-11', status:'tbd', radius:15, zip:'86403', ch:['email','text'], promo:'November raffle: stop by the booth.'}),
    it({id:'lakese26', type:'se', name:'Lakeside Service Event', start:'2026-11-16', end:'2026-11-16', radius:20, zip:'86403', ch:['email','text'], location:'Sample Inn'}),
    it({id:'bf26', type:'sale', name:'Black Friday sale', start:'2026-11-18', end:'2026-12-01', audience:'Sale list', ch:['email','text'],
      sends:[{ch:'email', date:'2026-11-18'}, {ch:'text', date:'2026-11-18'}, {ch:'email', date:'2026-11-24'}, {ch:'text', date:'2026-11-27'}]}),
    it({id:'winter27', name:'Lakeside Winter Fest', start:'2027-02-06', end:'2027-02-07', radius:20, zip:'86403', ch:['email','text'], promo:'January raffle: show the email.', wantsSE:true, linkSE:'lakese26'}),
    it({id:'balloon27', name:'Lakeside Balloon Festival', start:'2027-01-21', end:'2027-01-24', status:'possible', radius:20, zip:'86403', ch:['email','text'], wantsSE:true, linkSE:'lakese26'}),
    it({id:'wed26', type:'psa', name:'Out of office email', start:'2026-04-04', end:'2026-04-22', audience:'ALL clients', ch:['email']})
  ]};
}
const freshDemo = () => E.freshState(demoPlan(), '2026–27', TODAY);
const P = st => st.plans['2026–27'];
const item = (st, id) => P(st).items.find(x => x.id === id);

// ───────────── rules ─────────────
test('show sends: email 3 days before, text 1 day before', () => {
  const s = E.sendsFor(item(freshDemo(), 'expo26'), E.defaultRules());
  assert.deepStrictEqual(s.map(x => [x.ch, x.date]), [['email','2026-10-06'], ['text','2026-10-08']]);
});
test('service events: emails 14 + 4 days out, texts 7 + 3, with reminder and last-chance tags', () => {
  const s = E.sendsFor(item(freshDemo(), 'lakese26'), E.defaultRules());
  assert.deepStrictEqual(s.map(x => [E.sendName(x), x.date]),
    [['Email','2026-11-02'], ['Text','2026-11-09'], ['Last-chance text','2026-11-13'], ['Reminder email','2026-11-12']].sort((a, b) => a[1].localeCompare(b[1])));
});
test('sales and the All-AZ email send on their start date; custom sends override', () => {
  const st = freshDemo();
  assert.deepStrictEqual(E.sendsFor(item(st, 'sale26'), P(st).rules).map(x => x.date), ['2026-10-13', '2026-10-13']);
  assert.deepStrictEqual(E.sendsFor(item(st, 'bf26'), P(st).rules).map(x => x.ch+x.date), ['email2026-11-18', 'text2026-11-18', 'email2026-11-24', 'text2026-11-27']);
});
test('a fresh store counts everything already behind today as handled', () => {
  const st = freshDemo(), pine = item(st, 'pine26');
  assert.strictEqual(pine.prep.email1, '2026-09-22');
  assert.strictEqual(pine.prep.list_email, true);
  assert.ok(E.remDone(P(st), E.reminders(P(st), TODAY, true).find(r => r.key === 'send:pine26:email1')));
});

// ───────────── the advisor ─────────────
test('flags: blank booth inside 75 days, the next send unscheduled, month raffle mismatch, one SE promoted twice', () => {
  const st = freshDemo(), keys = E.allFlags(st, TODAY).map(f => f.key);
  assert.ok(keys.includes('booth:expo26'), 'booth');
  assert.ok(keys.some(k => k.startsWith('prep:expo26:email1')), 'unscheduled send');
  assert.ok(keys.includes('raffle:winter27'), 'January raffle on a February event');
  assert.ok(keys.includes('shared:lakese26'), 'one service event, two events');
  assert.ok(keys.includes('review:pine26') && keys.includes('review:se-pine26'), 'review prompts after an event wraps');
});
test('a TBD month inside the horizon asks for dates; "Looks right" keeps a question away', () => {
  const st = freshDemo();
  assert.ok(E.allFlags(st, TODAY).some(f => f.key === 'dates:lake26'));
  P(st).dismissed['raffle:winter27'] = true;
  assert.ok(!E.allFlags(st, TODAY).some(f => f.key === 'raffle:winter27'));
});
test('ticking the send clears the flag; moving the event afterwards asks for a reschedule', () => {
  const st = freshDemo(), x = item(st, 'expo26'), r = P(st).rules;
  E.setPrep(x, r, 'list_email', true); E.setPrep(x, r, 'email1', true);
  assert.ok(!E.allFlags(st, TODAY).some(f => f.key.startsWith('prep:expo26:email1')));
  x.start = '2026-10-16'; x.end = '2026-10-18';
  const f = E.allFlags(st, TODAY).find(y => y.key.startsWith('resched:expo26'));
  assert.ok(f, 'reschedule flag');
  assert.match(E.plain(f.text), /scheduled for 10\/6 now goes out Tue 10\/13/);
});

// ───────────── calendar ─────────────
const BANNERS = [
  {title:'Desert Home Expo', start:'2026-10-09', end:'2026-10-11', color:'3'},
  {title:'SC days', start:'2026-10-12', end:'2026-10-13', color:'3'},
  {title:'Fall sale', start:'2026-10-13', end:'2026-10-29', color:'1'},
  {title:'Send fall email', start:'2026-10-13', end:'2026-10-13', color:'1'},
  {title:'Lakeside Fair', start:'2026-11-13', end:'2026-11-14', color:'3'},
  {title:'Lakeside SE', start:'2026-11-16', end:'2026-11-16', color:'3'},
  {title:'Lakeside SE', start:'2027-02-05', end:'2027-02-05', color:'3'},
  {title:'Lakeside SE', start:'2027-02-08', end:'2027-02-08', color:'3'},
  {title:'Glendale Street Fair', start:'2026-10-24', end:'2026-10-25', color:'3'},
  {title:'Team meeting', start:'2026-10-08', end:'2026-10-08', color:'5'}
];
test('classify: skips SC days, one-day lavender and other colors; merges same-place SE days', () => {
  const feed = CalCore.classify(BANNERS);
  assert.ok(!feed.some(f => /SC days|Send fall|Team/.test(f.title)));
  const merged = feed.find(f => f.kind === 'se' && f.start === '2027-02-05');
  assert.deepStrictEqual([merged.end, merged.days], ['2027-02-08', ['2027-02-05', '2027-02-08']]);
});
test('the sync dates a TBD event, keeps matching ones, and lists the rest as questions', () => {
  const st = freshDemo();
  const r = E.runCalendarSync(st, BANNERS, 'weekly', TODAY, '2026-10-01T13:00:00.000Z');
  const lake = item(st, 'lake26');
  assert.deepStrictEqual([lake.start, lake.end, lake.status], ['2026-11-13', '2026-11-14', 'confirmed']);
  assert.ok(r.log.some(l => l.id === 'lake26' && l.lid));
  assert.ok(r.analysis.fresh.some(f => f.ev.title === 'Glendale Street Fair'));
  assert.strictEqual(st.cal.lastRun.ok, true);
  assert.ok(E.allFlags(st, TODAY).some(f => f.cal === 'fresh'));
  assert.ok(E.calUndo(st, r.log.find(l => l.id === 'lake26').lid));
  assert.strictEqual(item(st, 'lake26').start, '');
  E.runCalendarSync(st, BANNERS, 'weekly', TODAY, '2026-10-02T13:00:00.000Z');
  assert.strictEqual(item(st, 'lake26').start, '', 'an undone move is not made again');
});
test('a calendar that stops being checked becomes a Needs-you item', () => {
  const st = freshDemo();
  E.runCalendarSync(st, BANNERS, 'weekly', TODAY, '2026-10-01T13:00:00.000Z');
  assert.ok(!E.allFlags(st, '2026-10-05').some(f => f.cal === 'error'));
  assert.ok(E.allFlags(st, '2026-10-12').some(f => f.key.startsWith('calstale:')));
});

// ───────────── the store (Apps Script, on the simulator) ─────────────
const seedStore = (opts) => {
  const s = createStore(opts), doc = JSON.stringify(freshDemo());
  const r = s.call('save', {baseRev:0, doc, hash:E.hash(doc), source:'seed'});
  assert.ok(r.ok, JSON.stringify(r));
  return s;
};
test('store: needs the key, saves, reads back, and refuses a stale revision', () => {
  const s = seedStore();
  const bad = JSON.parse(s.ctx.doPost({postData:{contents:JSON.stringify({action:'load', key:'nope'})}}).getContent());
  assert.strictEqual(bad.error, 'bad_key');
  const cur = s.call('load');
  assert.strictEqual(cur.rev, 1);
  const st = JSON.parse(cur.doc); st.plans['2026–27'].items[0].name = 'Renamed';
  const d2 = JSON.stringify(st);
  assert.ok(s.call('save', {baseRev:1, doc:d2, hash:E.hash(d2)}).ok);
  const stale = s.call('save', {baseRev:1, doc:d2, hash:E.hash(d2)});
  assert.strictEqual(stale.error, 'conflict');
  assert.strictEqual(stale.rev, 2);
  assert.strictEqual(JSON.parse(stale.doc).plans['2026–27'].items[0].name, 'Renamed', 'a conflict hands back the newer plan');
});
test('store: refuses damaged text, non-plans, and a save that would drop half the plan', () => {
  const s = seedStore(), cur = s.call('load');
  assert.strictEqual(s.call('save', {baseRev:1, doc:cur.doc, hash:'0:deadbeef'}).error, 'bad_doc');
  assert.strictEqual(s.call('save', {baseRev:1, doc:'{"hello":1}'}).error, 'bad_doc');
  const st = JSON.parse(cur.doc); st.plans['2026–27'].items = st.plans['2026–27'].items.slice(0, 2);
  const d = JSON.stringify(st);
  assert.strictEqual(s.call('save', {baseRev:1, doc:d, hash:E.hash(d)}).error, 'shrink');
});
test('store: a plan larger than one Sheets cell is split and read back whole; History keeps the last 60', () => {
  const s = seedStore(), st = JSON.parse(s.call('load').doc);
  st.plans['2026–27'].items[1].notes = 'x'.repeat(120000);
  let rev = 1;
  for(let i = 0; i < 62; i++){
    st.plans['2026–27'].items[2].notes = 'save '+i;
    const d = JSON.stringify(st), r = s.call('save', {baseRev:rev, doc:d, hash:E.hash(d)});
    assert.ok(r.ok, JSON.stringify(r)); rev = r.rev;
  }
  const back = JSON.parse(s.call('load').doc);
  assert.strictEqual(back.plans['2026–27'].items[1].notes.length, 120000);
  assert.strictEqual(s.book.getSheetByName('History').getLastRow() - 1, 60);
});
test('store: a torn Store write falls back to History instead of serving a broken plan', () => {
  const s = seedStore();
  s.book.getSheetByName('Store').getRange(9, 1).setValues([['~{"broken']]);
  const r = s.call('load');
  assert.ok(r.ok && r.recovered && JSON.parse(r.doc).plans);
});
test('store: the weekly check moves dates, records the run, and fails closed on an empty calendar', () => {
  const s = seedStore({events:BANNERS, now:'2026-10-05T13:00:00Z'});
  s.ctx.weeklyCalendarCheck();
  let st = JSON.parse(s.call('load').doc);
  assert.strictEqual(st.plans['2026–27'].items.find(x => x.id === 'lake26').start, '2026-11-13');
  assert.strictEqual(st.cal.lastRun.ok, true);
  s.setEvents([]);
  assert.throws(() => s.ctx.weeklyCalendarCheck(), /no all-day events/);
  st = JSON.parse(s.call('load').doc);
  assert.strictEqual(st.cal.lastRun.ok, false);
  assert.strictEqual(st.plans['2026–27'].items.find(x => x.id === 'lake26').start, '2026-11-13', 'nothing moved on the failed run');
  s.setEvents(new Error('Calendar service unavailable'));
  const r = s.call('calcheck');
  assert.strictEqual(r.error, 'calendar');
  assert.match(r.message, /unavailable/);
});
test('store: setup makes a key and exactly one Monday 6am Arizona trigger', () => {
  const s = createStore({key:null});
  s.ctx.setup(); s.ctx.setup();
  assert.ok(s.props.MA_KEY && s.props.MA_KEY.length >= 40);
  assert.strictEqual(s.triggers.length, 1);
  assert.deepStrictEqual(s.triggers[0].spec, {handler:'weeklyCalendarCheck', day:'MONDAY', hour:6, tz:'America/Phoenix'});
});

// ───────────── Claude drafts ─────────────
function reviewed(st){
  const x = item(st, 'pine26');
  x.review = {liked:'Car crowd bought knives', change:'Go 30 miles and add Heber. Raffle the knife of the month. Send the email a day earlier.', next:'change', at:TODAY};
  return x;
}
test('a saved review with a change note asks Claude once; editing next year yourself skips it', () => {
  const st = freshDemo(), x = reviewed(st);
  assert.ok(E.maybeRequestDraft(x, '2026-10-01T10:00:00Z'));
  assert.ok(!E.maybeRequestDraft(x, '2026-10-01T10:05:00Z'), 'same note, no second request');
  const y = item(st, 'se-pine26');
  y.review = {change:'Different hotel', next:'change'}; y.nextEdits = {radius:25};
  assert.ok(!E.maybeRequestDraft(y, '2026-10-01T10:00:00Z'));
});
test('store + ALMA: pending hands out the prompt; a proposal is cleaned to the whitelist; a repeat is stale', () => {
  const s = seedStore(), st = JSON.parse(s.call('load').doc), x = st.plans['2026–27'].items.find(y => y.id === 'pine26');
  x.review = {liked:'ok', change:'Go 30 miles', next:'change'};
  E.maybeRequestDraft(x, '2026-10-01T10:00:00Z');
  const d = JSON.stringify(st); s.call('save', {baseRev:1, doc:d, hash:E.hash(d)});
  const pend = s.call('pending');
  assert.strictEqual(pend.items.length, 1);
  assert.match(pend.items[0].prompt, /Never invent dates, booth numbers/);
  const raw = '```json\n{"decision":"change","updates":{"radius":30,"booth":"12","start":"2027-01-01","ch":["email","fax"]},"summary":"30 miles.","unapplied":""}\n```';
  const r = s.call('propose', {pk:'2026–27', id:'pine26', requestedAt:'2026-10-01T10:00:00Z', raw, model:'claude-sonnet-5'});
  assert.strictEqual(r.status, 'ready');
  const got = JSON.parse(s.call('load').doc).plans['2026–27'].items.find(y => y.id === 'pine26').claude;
  assert.deepStrictEqual(got.proposal.updates, {radius:30, ch:['email']});
  assert.strictEqual(s.call('propose', {pk:'2026–27', id:'pine26', requestedAt:'2026-10-01T10:00:00Z', raw}).status, 'stale');
  assert.strictEqual(s.call('pending').items.length, 0);
  assert.strictEqual(s.props.MA_PENDING, '0');
});
test('an answer that is not JSON files an error the page shows, not a silent nothing', () => {
  const st = freshDemo(), x = reviewed(st);
  E.maybeRequestDraft(x, 'T1');
  assert.strictEqual(E.fileProposal(st, '2026–27', 'pine26', 'T1', 'Sure! Here you go.', 'm', 'T2'), 'error');
  assert.ok(E.allFlags(st, TODAY).some(f => f.key.startsWith('drafterr:pine26')));
});

// ───────────── next year's plan ─────────────
test('next year: reviews decide; your edits and accepted drafts carry; dates, booths and checklists start fresh', () => {
  const st = freshDemo(), x = reviewed(st);
  E.maybeRequestDraft(x, 'T1');
  E.fileProposal(st, '2026–27', 'pine26', 'T1', JSON.stringify({decision:'change', updates:{radius:30, cities:'Heber'}, summary:'30 miles, adds Heber.', unapplied:'Send the email a day earlier.'}), 'm', 'T2');
  E.acceptDraft(x, '2026-10-02T00:00:00Z');
  item(st, 'expo26').booth = '312';
  item(st, 'se-pine26').review = {next:'drop', change:'Nobody came'};
  const np = E.buildNextPlan(P(st), '2026–27', '2027–28', {});
  const pine = np.items.find(y => y.id === 'pine26-2027');
  assert.deepStrictEqual([pine.radius, pine.cities, pine.start, pine.status, pine.datesNote], [30, 'Heber', '', 'tbd', 'Dates come from your calendar']);
  assert.strictEqual(pine.lastYear.todo, 'Send the email a day earlier.');
  assert.match(pine.lastYear.applied, /Radius: 20 mi → 30 mi/);
  assert.strictEqual(pine.linkSE, '', 'its service event was dropped, so the link goes');
  assert.ok(!np.items.some(y => y.name === 'Pinecrest Service Event'));
  assert.ok(!np.items.some(y => y.name === 'Out of office email'), 'one-time announcements drop by default');
  assert.strictEqual(np.items.find(y => y.name === 'Desert Home Expo').booth, '');
  const bf = np.items.find(y => y.name === 'Black Friday sale');
  assert.deepStrictEqual(bf.relSends.map(s => s.off), [0, 0, 6, 9], 'custom send days re-anchor to next year’s start');
  const kick = np.items.find(y => y.kickoff);
  assert.strictEqual(kick.start, '2027-08-31', 'self-scheduled items move forward 52 weeks');
  assert.deepStrictEqual(np.rules.handoffs.map(h => h.camp+' '+h.date), ['2027-CIII 2027-09-01']);
  assert.deepStrictEqual(np.dropped.map(d => d.name).sort(), ['Out of office email', 'Pinecrest Service Event']);
});
test('a change note with no edits and no draft still carries over, as a to-do', () => {
  const st = freshDemo(); reviewed(st);
  const np = E.buildNextPlan(P(st), '2026–27', '2027–28', {});
  assert.match(np.items.find(y => y.id === 'pine26-2027').lastYear.todo, /Go 30 miles/);
});

// ───────────── digest (ALMA) ─────────────
test('digest: tomorrow’s unscheduled sends, fixes inside a week, calendar status, ready drafts', () => {
  const st = freshDemo();
  const d = E.digest(st, '2026-10-05');
  assert.deepStrictEqual(d.sends.map(s => s.when+' '+s.text), ['tomorrow Email goes out: Desert Home Expo']);
  assert.ok(d.fixes.some(f => /booth/.test(f.text)));
  assert.strictEqual(d.calendar.stale, true, 'never checked counts as stale');
  assert.ok(!/<b>/.test(JSON.stringify(d)), 'plain text for Slack');
});

// ───────────── the page and the Apps Script run the same code ─────────────
test('apps-script/Marketing.gs is built from the current engine and calendar core', () => {
  assert.strictEqual(fs.readFileSync(OUT, 'utf8'), build(), 'run: node tools/build-gs.js');
});
test('nothing personal lands in the public repo’s marketing files', () => {
  const root = path.join(__dirname, '..');
  const files = ['marketing/calcore.js', 'marketing/engine.js', 'marketing/ui.js', 'marketing/marketing.css', 'apps-script/Marketing.src.gs', 'apps-script/README.md', 'tools/dev-server.js', 'tools/gas-sim.js', 'tools/store.js'];
  for(const f of files){
    const p = path.join(root, f); if(!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    assert.ok(!/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/.test(t), f+': looks like a phone number');
    const emails = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).filter(e => !/@example\.com$/.test(e));
    assert.deepStrictEqual(emails, [], f+': has an email address');
  }
});

test('store: History lists saves and restore puts one back as the newest revision', () => {
  const s = seedStore(), st = JSON.parse(s.call('load').doc);
  st.plans['2026–27'].items[0].name = 'Oops';
  const d = JSON.stringify(st); s.call('save', {baseRev:1, doc:d, hash:E.hash(d)});
  assert.deepStrictEqual(s.call('history').items.map(h => h.rev), [2, 1]);
  const r = s.call('restore', {rev:1});
  assert.deepStrictEqual([r.ok, r.rev], [true, 3]);
  assert.notStrictEqual(JSON.parse(s.call('load').doc).plans['2026–27'].items[0].name, 'Oops');
  assert.strictEqual(s.call('restore', {rev:99}).error, 'not_found');
});

test('store: metadata survives Sheets turning time-looking text into numbers', () => {
  const s = seedStore();
  // write a plan whose hash is all digits after the colon, the shape Sheets reads as a time
  let st = JSON.parse(s.call('load').doc), rev = 1, n = 0;
  do { st.plans['2026–27'].items[0].notes = 'n'+(n++); } while(!/^\d+:\d+$/.test(E.hash(JSON.stringify(st))) && n < 5000);
  assert.ok(/^\d+:\d+$/.test(E.hash(JSON.stringify(st))), 'found an all-digit hash');
  const d = JSON.stringify(st), r = s.call('save', {baseRev:rev, doc:d, hash:E.hash(d)});
  assert.ok(r.ok, JSON.stringify(r));
  const back = s.call('load');
  assert.ok(back.ok && !back.recovered && back.hash === E.hash(d));
});
