'use strict';
// node --test tests/events_auto.test.js
// The engine lives inline in index.html, so this lifts the real functions out of it and runs them:
// a Load from the Sheets snapshot must never drop or roll back an event row the automation keeps.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `index.html has no function ${name}`);
  let depth = 0;
  for (let i = html.indexOf('{', at); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
  }
  throw new Error(`function ${name} never closes`);
}
function engine(dataJson) {
  const ctx = vm.createContext({ S: JSON.parse(JSON.stringify(dataJson)), BOOT_AUTO_EVENTS: [] });
  vm.runInContext(['isAutoEvent', 'keepAutoEvents', 'mergeSyncData'].map(lift).join('\n'), ctx);
  vm.runInContext('BOOT_AUTO_EVENTS = (S.events || []).filter(isAutoEvent).map(e => JSON.parse(JSON.stringify(e)));', ctx);   // what bootHub does
  return ctx;
}
const hand = (name, extra = {}) => ({ name, cpo: 100, net: 45, dt: '2026-07-17', ...extra });
const auto = (vcId, extra = {}) => ({ name: 'Katy Home & Outdoor Living Show', vcId, cpo: 4940, net: 1301.68, hotel: 0, auto: { need: ['travel'] }, ...extra });

test('bootHub remembers the automatic rows', () => {
  assert.match(html, /Object\.assign\(S, fetched\);\s*BOOT_AUTO_EVENTS = \(S\.events \|\| \[\]\)\.filter\(isAutoEvent\)/);
});

test('Load: a snapshot saved before the row existed does not drop it', () => {
  const e = engine({ repName: 'A', weeks: [], events: [hand('Maricopa'), auto('00091588')] });
  vm.runInContext('mergeSyncData({ repName: "A", weeks: [], events: [' + JSON.stringify(hand('Maricopa', { hotel: 99 })) + '] })', e);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.S.events)), [hand('Maricopa', { hotel: 99 }), auto('00091588')]);   // hand row from the snapshot, auto row from data.json
});

test('Load: a snapshot holding an older copy of the row does not roll it back, and cannot add one data.json lacks', () => {
  const e = engine({ repName: 'A', weeks: [], events: [auto('00091588', { hotel: 240, net: 1061.68, auto: { need: [] } })] });
  vm.runInContext('mergeSyncData({ repName: "A", weeks: [], events: [' + [auto('00091588'), auto('00000001'), hand('By hand in the HUB')].map(x => JSON.stringify(x)).join(',') + '] })', e);
  const got = JSON.parse(JSON.stringify(e.S.events));
  assert.deepStrictEqual(got, [hand('By hand in the HUB'), auto('00091588', { hotel: 240, net: 1061.68, auto: { need: [] } })]);
});

test('Load with no events in the snapshot still leaves a list', () => {
  const e = engine({ repName: 'A', weeks: [], events: [auto('00091588')] });
  vm.runInContext('mergeSyncData({ repName: "A", weeks: [] })', e);
  assert.strictEqual(e.S.events.length, 1);
});

test('the form refuses an automatic row, and all three lists use the shared buttons', () => {
  assert.match(lift('editEvent'), /if\(isAutoEvent\(e\)\)\{ alert\(AUTO_HOW\); return; \}/);
  assert.match(lift('deleteEvent'), /if\(isAutoEvent\(e\)\)\{ alert\(AUTO_HOW\); return; \}/);
  assert.strictEqual((html.match(/\$\{eventButtons\(/g) || []).length, 3);
  assert.strictEqual((html.match(/onclick="editEvent\(/g) || []).length, 1);          // only inside eventButtons
});
