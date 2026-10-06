#!/usr/bin/env node
// Local preview of the Command Center with a simulated Marketing store.
//   node tools/dev-server.js [--port 4190] [--seed plan.json] [--calendar banners.json] [--today YYYY-MM-DD]
// Serves the repo and answers POST /exec with apps-script/Marketing.gs running on
// tools/gas-sim.js. Open http://localhost:4190/?store=http://localhost:4190/exec
// and connect with the key "dev-key". The store lives in memory: restart = fresh.
process.env.TZ = process.env.TZ || 'America/Phoenix';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./gas-sim');
const E = require('../marketing/engine.js');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('--port', 4190);
const ROOT = path.join(__dirname, '..');
const KEY = 'dev-key';
const events = arg('--calendar') ? JSON.parse(fs.readFileSync(arg('--calendar'), 'utf8')) : [];
const store = createStore({ events, key: KEY });
if (arg('--seed')) {
  const doc = fs.readFileSync(arg('--seed'), 'utf8');
  const r = store.call('save', { baseRev: 0, doc, hash: E.hash(doc), source: 'seed' });
  console.log('seeded:', r.ok ? 'rev ' + r.rev : r.message);
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let out;
      try { out = store.ctx.doPost({ postData: { contents: body } }).getContent(); }
      catch (e) { out = JSON.stringify({ ok: false, error: 'server', message: e.message }); }
      const a = (() => { try { return JSON.parse(body).action; } catch (e) { return '?'; } })();
      console.log(new Date().toISOString().slice(11, 19), 'POST', a, out.length + 'B');
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(out); }, +arg('--latency', 250));
    });
    return;
  }
  if (url.pathname === '/_sim/events' && req.method === 'POST') { // swap the fake calendar during QA
    let body = ''; req.on('data', c => (body += c)); req.on('end', () => { store.setEvents(JSON.parse(body)); res.end('ok'); }); return;
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Command Center dev: http://localhost:${PORT}/?store=http://localhost:${PORT}/exec  (key: ${KEY})`));
