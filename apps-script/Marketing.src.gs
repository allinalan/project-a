// ==== Command Center Marketing: the store ====================================
// Apps Script bound to the "Command Center Marketing" Google Sheet. It keeps the
// marketing plan the Command Center's Marketing page reads and writes, runs the
// Monday calendar check, and answers ALMA (the morning digest and Claude drafts).
// It never sends email or texts and never touches the Vast Action CRM.
//
// Setup (once): apps-script/README.md. Deployed as a web app: Execute as Me,
// Who has access: Anyone. Every call except `ping` needs the store key
// (Script property MA_KEY, created by setup()).
//
// How saves stay safe:
//  - Every save names the revision it was based on. If the store moved on (the
//    calendar check, ALMA, another device), the save is refused and the caller
//    gets the current plan back to re-apply its edit on top. Nothing is overwritten.
//  - Each save is written to History first, then to Store, then read back and
//    checked against the hash the page sent. A torn Store write falls back to History.
//  - A save that would drop more than half the plan's items is refused.
var MA_TZ = 'America/Phoenix';
var MA_APP = 'cc-marketing';
var MA_VERSION = '2026-09-29';
var MA_CHUNK = 45000;       // a Sheets cell holds 50,000 characters
var MA_HISTORY_KEEP = 60;
var MA_LOG_KEEP = 500;

function doGet(){
  return json_({ok:true, app:MA_APP, version:MA_VERSION, note:'POST only. This store answers the Command Center Marketing page.'});
}

function doPost(e){
  var body;
  try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch(err){ return json_({ok:false, error:'bad_request', message:'The request was not JSON.'}); }
  var action = String(body.action || '');
  if(action === 'ping') return json_({ok:true, app:MA_APP, version:MA_VERSION, keySet:!!prop_('MA_KEY'), tz:Session.getScriptTimeZone()});
  if(!prop_('MA_KEY')) return json_({ok:false, error:'setup_needed', message:'Run setup() in the Apps Script editor first.'});
  if(!keyOk_(body.key)) return json_({ok:false, error:'bad_key', message:'That key doesn’t match this store.'});
  try{
    if(action === 'load') return json_(load_());
    if(action === 'save') return json_(save_(body));
    if(action === 'calcheck') return json_(calendarCheck_('button'));
    if(action === 'digest') return json_(digest_(body));
    if(action === 'pending') return json_(pending_());
    if(action === 'propose') return json_(propose_(body));
    if(action === 'drafterror') return json_(draftError_(body));
    if(action === 'history') return json_(history_());
    if(action === 'restore') return json_(restore_(body));
    return json_({ok:false, error:'bad_action', message:'Unknown action: '+action});
  }catch(err){
    log_('error', action+': '+(err && err.message || err));
    return json_({ok:false, error:'server', message:String(err && err.message || err)});
  }
}

// ---- actions -----------------------------------------------------------------

function load_(){
  var cur = readStore_();
  return {ok:true, rev:cur.rev, doc:cur.doc, hash:cur.hash, savedAt:cur.savedAt, source:cur.source, recovered:!!cur.recovered};
}

function save_(body){
  var docStr = String(body.doc || '');
  if(docStr.length > 3000000) return {ok:false, error:'too_big', message:'The plan is over 3 MB. Something is wrong; nothing was saved.'};
  if(body.hash && body.hash !== MAEngine.hash(docStr)) return {ok:false, error:'bad_doc', message:'The plan arrived damaged. Nothing was saved; try again.'};
  var state;
  try{ state = JSON.parse(docStr); }catch(err){ return {ok:false, error:'bad_doc', message:'The plan was not valid JSON. Nothing was saved.'}; }
  if(!MAEngine.validState(state)) return {ok:false, error:'bad_doc', message:'That doesn’t look like a marketing plan. Nothing was saved.'};
  return withLock_(function(){
    var cur = readStore_();
    if(Number(body.baseRev) !== cur.rev) return {ok:false, error:'conflict', rev:cur.rev, doc:cur.doc, savedAt:cur.savedAt, source:cur.source};
    if(cur.rev && !body.allowShrink){
      var before = countItems_(JSON.parse(cur.doc)), after = countItems_(state);
      if(before >= 10 && after < before / 2) return {ok:false, error:'shrink', message:'That save would drop the plan from '+before+' to '+after+' items, so it was refused.'};
    }
    var source = String(body.source || 'page').slice(0, 40);
    var out = write_(docStr, cur.rev + 1, source, state);
    if(source !== 'page' || body.note) log_('save', source+' r'+out.rev+(body.note ? ': '+String(body.note).slice(0, 200) : ''));
    return {ok:true, rev:out.rev, hash:out.hash, savedAt:out.savedAt};
  });
}

// Runs the calendar check and files what it found on the plan. Fails closed: if the
// calendar can't be read, or comes back empty, no plan date changes and the error is
// recorded where the page and ALMA will show it.
function calendarCheck_(source){
  var today = today_(), nowIso = new Date().toISOString();
  var cur = readStore_();
  if(!cur.rev) return {ok:false, error:'no_plan', message:'No plan is saved yet.'};
  var state0 = JSON.parse(cur.doc);
  var rules = (state0.plans[state0.active] || {}).rules || {};
  var raw = null, err = '';
  try{
    raw = readCalendarBanners_(String(rules.calendarId || '').trim());
    if(!raw.length) err = 'Google Calendar returned no all-day events for the next 12 months. Check the calendar in Rules.';
  }catch(e){ err = String(e && e.message || e); }
  var res = mutate_('calendar', function(state){
    if(err){ MAEngine.recordCalendarError(state, source, err, nowIso); return {error:err}; }
    var r = MAEngine.runCalendarSync(state, raw, source, today, nowIso);
    return {updated:r.log.length, changes:r.log.map(function(l){ return l.name+': '+l.fromLabel+' -> '+l.toLabel; }),
      weak:r.analysis.weak.length, missing:r.analysis.missing.length, fresh:r.analysis.fresh.length, outside:r.analysis.outside.length, banners:raw.length};
  });
  log_('calendar', source+(err ? ' FAILED: '+err : ': '+res.result.banners+' banners, '+res.result.updated+' dates updated'+(res.result.updated ? ' ('+res.result.changes.join('; ')+')' : '')));
  if(err) return {ok:false, error:'calendar', message:err, rev:res.rev};
  return {ok:true, rev:res.rev, result:res.result};
}

function digest_(body){
  var cur = readStore_();
  if(!cur.rev) return {ok:false, error:'no_plan', message:'No plan is saved yet.'};
  var state = MAEngine.migrate(JSON.parse(cur.doc));
  var today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || '') ? body.today : today_();
  return {ok:true, rev:cur.rev, digest:MAEngine.digest(state, today)};
}

// Claude drafts: ALMA on the Mac mini asks for open requests, sends each prompt to
// Claude with its own key (the key never leaves the mini) and files the answer here.
function pending_(){
  if(prop_('MA_PENDING') === '0') return {ok:true, items:[]};
  var cur = readStore_();
  if(!cur.rev) return {ok:true, items:[]};
  return {ok:true, items:MAEngine.pendingDrafts(JSON.parse(cur.doc)).slice(0, 5)};
}

function propose_(body){
  var nowIso = new Date().toISOString(), status = '';
  var res = mutate_('claude', function(state){
    status = MAEngine.fileProposal(state, String(body.pk || ''), String(body.id || ''), String(body.requestedAt || ''), String(body.raw || ''), body.model, nowIso);
    return status === 'stale' ? false : status;
  });
  log_('claude', (body.id || '?')+': '+status);
  return {ok:true, status:status, rev:res.rev};
}

function draftError_(body){
  var nowIso = new Date().toISOString(), status = '';
  var res = mutate_('claude', function(state){
    status = MAEngine.fileDraftError(state, String(body.pk || ''), String(body.id || ''), String(body.requestedAt || ''), String(body.message || ''), nowIso);
    return status === 'stale' ? false : status;
  });
  log_('claude', (body.id || '?')+': error filed ('+String(body.message || '').slice(0, 120)+')');
  return {ok:true, status:status, rev:res.rev};
}

// Rollback: list the saves History keeps, and put one back as the newest revision.
function history_(){
  var sh = sheet_('History'), last = sh.getLastRow(), out = [];
  for(var r = last; r >= 2 && out.length < 60; r--){
    var h = sh.getRange(r, 1, 1, 5).getValues()[0];
    out.push({rev:Number(h[0]), savedAt:untxt_(h[1]), source:untxt_(h[2]), length:Number(h[3])});
  }
  return {ok:true, items:out};
}
function restore_(body){
  var want = Number(body.rev);
  return withLock_(function(){
    var sh = sheet_('History'), last = sh.getLastRow(), found = null;
    for(var r = last; r >= 2; r--){
      var head = sh.getRange(r, 1, 1, 6).getValues()[0];
      if(Number(head[0]) !== want) continue;
      var doc = unchunk_(sh.getRange(r, 7, 1, Number(head[5]) || 1).getValues()[0]);
      if(MAEngine.hash(doc) !== untxt_(head[4])) return {ok:false, error:'damaged', message:'History row r'+want+' failed its check.'};
      found = doc; break;
    }
    if(!found) return {ok:false, error:'not_found', message:'History has no r'+want+' (it keeps the last '+MA_HISTORY_KEEP+' saves).'};
    var cur = readStore_(), out = write_(found, cur.rev + 1, 'restore r'+want, JSON.parse(found));
    log_('restore', 'r'+want+' restored as r'+out.rev);
    return {ok:true, rev:out.rev, restored:want};
  });
}

// ---- triggers + editor functions ---------------------------------------------

// The weekly check (Mondays 6am Arizona). A failure throws, so Google emails Alan
// the failure, and it is recorded on the plan so the page and ALMA say so too.
function weeklyCalendarCheck(){
  var r = calendarCheck_('weekly');
  if(!r.ok) throw new Error('Marketing calendar check failed: '+r.message);
}

// Run once from the editor: creates the tabs, the store key and the weekly trigger,
// and asks for calendar access.
function setup(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if(!ss) throw new Error('Open this script from the Command Center Marketing Sheet (Extensions > Apps Script) and run setup() there.');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('MA_SHEET_ID', ss.getId());
  ['Store', 'History', 'Log'].forEach(sheet_);
  if(!props.getProperty('MA_KEY')) props.setProperty('MA_KEY', Utilities.getUuid().replace(/-/g, '')+Utilities.getUuid().replace(/-/g, '').slice(0, 12));
  if(!props.getProperty('MA_PENDING')) props.setProperty('MA_PENDING', '0');
  installWeeklyCheck_();
  var cal = CalendarApp.getDefaultCalendar();
  log_('setup', 'tabs, key and Monday 6am trigger in place; calendar '+cal.getName());
  Logger.log('Setup done.\nWeekly calendar check: Mondays 6am Arizona time.\nMain calendar: '+cal.getName()+
    '\nStore key: '+props.getProperty('MA_KEY')+'\n(It also stays under Project Settings > Script properties > MA_KEY.)');
}

function showKey(){ Logger.log('Store key: '+prop_('MA_KEY')); }

// Reads the calendar and reports what it would match, without saving anything.
function testCalendar(){
  var cur = readStore_(), calId = '';
  if(cur.rev){ var st = JSON.parse(cur.doc); calId = String(((st.plans[st.active] || {}).rules || {}).calendarId || '').trim(); }
  var raw = readCalendarBanners_(calId), feed = CalCore.classify(raw);
  Logger.log(raw.length+' all-day events in the next 12 months; '+feed.length+' count as marketing (purple shows/SEs, lavender multi-day sales).\n'+
    feed.slice(0, 25).map(function(f){ return f.kind+'  '+f.start+(f.end !== f.start ? ' to '+f.end : '')+'  '+f.title; }).join('\n'));
}

function installWeeklyCheck_(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction() === 'weeklyCalendarCheck') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('weeklyCalendarCheck').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).inTimezone(MA_TZ).create();
}

// ---- calendar ----------------------------------------------------------------

// All-day, non-recurring events only; CalCore filters by color and skips SC days.
function readCalendarBanners_(calId){
  var cal = calId ? CalendarApp.getCalendarById(calId) : CalendarApp.getDefaultCalendar();
  if(!cal) throw new Error('Can’t open calendar '+calId+'. Run the store as that calendar’s owner, or share the calendar with it.');
  var tz = Session.getScriptTimeZone(), now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var end = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate() + 1);
  return cal.getEvents(start, end).filter(function(e){ return e.isAllDayEvent() && !e.isRecurringEvent(); }).map(function(e){
    var s = e.getAllDayStartDate(), x = e.getAllDayEndDate();
    var last = new Date(x.getFullYear(), x.getMonth(), x.getDate() - 1); // Google's all-day end is the day after
    return {title:e.getTitle(), start:Utilities.formatDate(s, tz, 'yyyy-MM-dd'), end:Utilities.formatDate(last < s ? s : last, tz, 'yyyy-MM-dd'), color:String(e.getColor() || '')};
  });
}

// ---- storage -----------------------------------------------------------------

function book_(){
  var ss = null;
  try{ ss = SpreadsheetApp.getActiveSpreadsheet(); }catch(e){ ss = null; }
  if(!ss && prop_('MA_SHEET_ID')) ss = SpreadsheetApp.openById(prop_('MA_SHEET_ID'));
  if(!ss) throw new Error('The store’s Sheet isn’t set. Run setup().');
  return ss;
}
function sheet_(name){
  var ss = book_(), sh = ss.getSheetByName(name);
  if(sh) return sh;
  sh = ss.insertSheet(name);
  if(name === 'History') sh.getRange(1, 1, 1, 6).setValues([['rev', 'savedAt', 'source', 'length', 'hash', 'chunks (then the plan, in pieces)']]);
  if(name === 'Log') sh.getRange(1, 1, 1, 3).setValues([['when', 'what', 'detail']]);
  return sh;
}
// Sheets turns text that looks like a number, date or time into one; '~' keeps these cells text.
function txt_(v){ return '~'+String(v); }
function untxt_(v){ return String(v).replace(/^~/, ''); }
function chunks_(str){ var out = []; for(var i = 0; i < str.length; i += MA_CHUNK) out.push('~'+str.slice(i, i + MA_CHUNK)); return out.length ? out : ['~']; }
function unchunk_(cells){ return cells.map(function(c){ return String(c).replace(/^~/, ''); }).join(''); }

function readStore_(){
  var sh = sheet_('Store');
  var meta = sh.getRange(1, 2, 6, 1).getValues().map(function(r){ return r[0]; });
  var rev = Number(meta[0]) || 0;
  if(!rev) return {rev:0, doc:'', hash:'', savedAt:'', source:''};
  var n = Number(meta[5]) || 0;
  var doc = n ? unchunk_(sh.getRange(9, 1, n, 1).getValues().map(function(r){ return r[0]; })) : '';
  var h = MAEngine.hash(doc);
  if(h === untxt_(meta[4])) return {rev:rev, doc:doc, hash:h, savedAt:untxt_(meta[1]), source:untxt_(meta[2])};
  var hist = latestHistory_();
  if(hist){ log_('recover', 'Store failed its check (r'+rev+'); read r'+hist.rev+' from History'); hist.recovered = true; return hist; }
  throw new Error('The saved plan failed its integrity check and History is empty. Nothing was changed.');
}
function latestHistory_(){
  var sh = sheet_('History'), last = sh.getLastRow();
  for(var r = last; r >= 2 && r > last - 5; r--){
    var head = sh.getRange(r, 1, 1, 6).getValues()[0], n = Number(head[5]) || 0;
    if(!n) continue;
    var doc = unchunk_(sh.getRange(r, 7, 1, n).getValues()[0]);
    if(MAEngine.hash(doc) === untxt_(head[4])) return {rev:Number(head[0]), doc:doc, hash:untxt_(head[4]), savedAt:untxt_(head[1]), source:untxt_(head[2])};
  }
  return null;
}
// History first, then Store, then read back. Callers hold the lock.
function write_(docStr, rev, source, state){
  var savedAt = new Date().toISOString(), h = MAEngine.hash(docStr), parts = chunks_(docStr);
  var hs = sheet_('History');
  if(hs.getMaxColumns() < 6 + parts.length) hs.insertColumnsAfter(hs.getMaxColumns(), 6 + parts.length - hs.getMaxColumns());
  hs.getRange(hs.getLastRow() + 1, 1, 1, 6 + parts.length).setValues([[rev, txt_(savedAt), txt_(source), docStr.length, txt_(h), parts.length].concat(parts)]);
  var extra = hs.getLastRow() - 1 - MA_HISTORY_KEEP;
  if(extra > 0) hs.deleteRows(2, extra);
  var sh = sheet_('Store');
  var oldN = Number(sh.getRange(6, 2).getValue()) || 0;
  sh.getRange(9, 1, parts.length, 1).setValues(parts.map(function(c){ return [c]; }));
  if(oldN > parts.length) sh.getRange(9 + parts.length, 1, oldN - parts.length, 1).clearContent();
  sh.getRange(1, 1, 7, 2).setValues([['rev', rev], ['savedAt', txt_(savedAt)], ['source', txt_(source)], ['length', docStr.length], ['hash', txt_(h)], ['chunks', parts.length],
    ['note', 'Written by the Marketing store. Don’t edit by hand; to roll back, ask Claude to restore a revision from History.']]);
  SpreadsheetApp.flush();
  notePending_(state);
  var back = readStore_();
  if(back.rev !== rev || back.hash !== h) throw new Error('Read-back after saving r'+rev+' did not match what was sent.');
  return {rev:rev, hash:h, savedAt:savedAt};
}
// Server-side change to the plan (calendar check, Claude drafts). fn returns false for "no change".
function mutate_(source, fn){
  return withLock_(function(){
    var cur = readStore_();
    if(!cur.rev) throw new Error('No plan is saved yet.');
    var state = MAEngine.migrate(JSON.parse(cur.doc));
    var result = fn(state);
    if(result === false) return {rev:cur.rev, result:null, changed:false};
    var out = write_(JSON.stringify(state), cur.rev + 1, source, state);
    return {rev:out.rev, result:result, changed:true};
  });
}
function notePending_(state){
  PropertiesService.getScriptProperties().setProperty('MA_PENDING', String(MAEngine.pendingDrafts(state).length));
}
function countItems_(state){ var n = 0; Object.keys(state.plans || {}).forEach(function(k){ n += ((state.plans[k] || {}).items || []).length; }); return n; }
function withLock_(fn){
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try{ return fn(); } finally { lock.releaseLock(); }
}

// ---- small helpers -----------------------------------------------------------

function today_(){ return Utilities.formatDate(new Date(), MA_TZ, 'yyyy-MM-dd'); }
function prop_(k){ return PropertiesService.getScriptProperties().getProperty(k); }
function keyOk_(k){
  var real = prop_('MA_KEY') || '', got = String(k || '');
  if(!real || got.length !== real.length) return false;
  var diff = 0;
  for(var i = 0; i < real.length; i++) diff |= real.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
function json_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function log_(what, detail){
  try{
    var sh = sheet_('Log');
    sh.appendRow([new Date(), what, String(detail || '').slice(0, 1000)]);
    var extra = sh.getLastRow() - 1 - MA_LOG_KEEP;
    if(extra > 0) sh.deleteRows(2, extra);
  }catch(e){ /* the log must never break a save */ }
}
