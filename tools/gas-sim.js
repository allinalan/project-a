// A small stand-in for the Google services apps-script/Marketing.gs uses, so the
// store can be tested (tests/) and driven by the local dev server (tools/dev-server.js)
// without Google. It models only what the store touches: one Sheet with tabs,
// script properties, a script lock, the calendar, triggers and the web-app output.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { build } = require('./build-gs');

const CELL_MAX = 50000;

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) { const v = (this.sheet.cells[this.row + r - 1] || [])[this.col + c - 1]; line.push(v === undefined ? '' : v); }
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (vals.length !== this.rows || vals.some(l => l.length !== this.cols)) throw new Error('The number of rows or columns in the data does not match the range.');
    if (this.col + this.cols - 1 > this.sheet.maxCols) throw new Error('Those columns are out of bounds.');
    vals.forEach((line, r) => line.forEach((v, c) => {
      if (typeof v === 'string' && v.length > CELL_MAX) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
      if (typeof v === 'string' && /^[=+]/.test(v)) throw new Error('sim: a value starting with = or + would be read as a formula');
      v = sheetsParse(v);
      const rr = this.row + r - 1;
      this.sheet.cells[rr] = this.sheet.cells[rr] || [];
      this.sheet.cells[rr][this.col + c - 1] = v;
    }));
    return this;
  }
  clearContent() { for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) { const line = this.sheet.cells[this.row + r - 1]; if (line) line[this.col + c - 1] = ''; } return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.cells = []; this.maxCols = 26; }
  getName() { return this.name; }
  getRange(row, col, rows = 1, cols = 1) { return new Range(this, row, col, rows, cols); }
  getLastRow() { for (let r = this.cells.length; r > 0; r--) if ((this.cells[r - 1] || []).some(v => v !== '' && v !== undefined)) return r; return 0; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  appendRow(vals) { this.getRange(this.getLastRow() + 1, 1, 1, vals.length).setValues([vals]); }
  deleteRows(start, n) { this.cells.splice(start - 1, n); }
}
class Spreadsheet {
  constructor() { this.sheets = {}; this.id = 'sim-sheet'; }
  getId() { return this.id; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new Sheet(n)); }
}

// Like Sheets: text that looks like a number, date or time is stored as a number/Date, not text.
function sheetsParse(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(t)) return new Date(t);
  if (/^\d+:\d+(:\d+)?$/.test(t) || /^\d+:[0-9a-f]+$/i.test(t) && /^\d+:\d+$/.test(t)) return Number(t.split(':')[0]) / 24;
  return v;
}
function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(d, tz, fmt) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
  throw new Error('sim formatDate: unsupported format ' + fmt);
}

// events: [{title, start:'YYYY-MM-DD', end:'YYYY-MM-DD' (last day, inclusive), color, recurring?, timed?}]
function makeCalendar(getEvents) {
  const toEvent = e => {
    const [y, m, d] = e.start.split('-').map(Number), [y2, m2, d2] = (e.end || e.start).split('-').map(Number);
    return {
      isAllDayEvent: () => !e.timed, isRecurringEvent: () => !!e.recurring, getTitle: () => e.title,
      getAllDayStartDate: () => new Date(y, m - 1, d), getAllDayEndDate: () => new Date(y2, m2 - 1, d2 + 1), getColor: () => e.color || '',
      _start: new Date(y, m - 1, d), _end: new Date(y2, m2 - 1, d2 + 1)
    };
  };
  const cal = {
    getName: () => 'Sim calendar',
    getEvents: (a, b) => { const list = getEvents(); if (list instanceof Error) throw list; return list.map(toEvent).filter(x => x._start < b && x._end > a); }
  };
  return { getDefaultCalendar: () => cal, getCalendarById: id => (id === 'missing@example.com' ? null : cal) };
}

// Returns {ctx, call(action, extra), setEvents, props, book, triggers, logs}
function createStore({ events = [], key = 'test-key-123', now = null } = {}) {
  const book = new Spreadsheet();
  const props = {};
  const triggers = [];
  const logs = [];
  let evs = events;
  const trig = handler => ({ getHandlerFunction: () => handler });
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book, flush: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    CalendarApp: makeCalendar(() => evs),
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; }, getContent() { return s; } }) },
    Utilities: { formatDate, getUuid: () => crypto.randomUUID() },
    Session: { getScriptTimeZone: () => 'America/Phoenix', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Logger: { log: m => logs.push(String(m)) },
    ScriptApp: {
      WeekDay: { MONDAY: 'MONDAY' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: h => { const spec = { handler: h }; const chain = { timeBased: () => chain, onWeekDay: d => (spec.day = d, chain), atHour: n => (spec.hour = n, chain), inTimezone: z => (spec.tz = z, chain), create: () => { const t = Object.assign(trig(h), { spec }); triggers.push(t); return t; } }; return chain; }
    }
  };
  if (now) {
    const RealDate = Date;
    ctx.Date = class extends RealDate { constructor(...a) { if (!a.length) super(now); else super(...a); } static now() { return new RealDate(now).getTime(); } };
  }
  vm.createContext(ctx);
  vm.runInContext(build(), ctx, { filename: 'Marketing.gs' });
  if (key) { ctx.setup(); props.MA_KEY = key; }
  const call = (action, extra = {}) => {
    const out = ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ action, key }, extra)) } });
    return JSON.parse(out.getContent());
  };
  return { ctx, call, setEvents: e => { evs = e; }, props, book, triggers, logs };
}

module.exports = { createStore, formatDate };
