// Real-exe smoke test (Windows): drives the built gw-desktop.exe through tauri-driver (WebDriver).
// Checks: the app starts, a CSV loads, an AI chart renders through the real Rust AI proxy
// (HTTPS with a self-signed certificate, "Verify SSL" off, custom header), verify-on is rejected,
// and the built-in basemap endpoint returns a PNG.
//
// Usage: node tests/smoke/smoke.mjs <path to gw-desktop.exe> <cert.pem> <key.pem>
// Needs tauri-driver on PATH and a matching msedgedriver (see .github/workflows/gw-desktop.yml).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const [exe, certFile, keyFile] = process.argv.slice(2);
if (!exe || !certFile || !keyFile) throw new Error('usage: smoke.mjs <exe> <cert.pem> <key.pem>');
const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root, 'smoke-results');
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// 1. Mock AI endpoint: HTTPS, self-signed, OpenAI format.
const aiRequests = [];
const server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    aiRequests.push({ url: req.url, headers: req.headers, body });
    const spec = { mark: 'bar', name: 'Sales by region', x: 'Region', y: 'sum(Sales)' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(spec) } }] }));
  });
});
await new Promise((r) => server.listen(8787, '127.0.0.1', r));

// 2. AI settings the app reads at start (%APPDATA%\<identifier>\ai-settings.json).
const identifier = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).identifier;
const configDir = process.platform === 'win32'
  ? path.join(process.env.APPDATA, identifier)
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), identifier);
fs.mkdirSync(configDir, { recursive: true });
const aiSettings = {
  enabled: true, apiStyle: 'openai', baseUrl: 'https://127.0.0.1:8787/v1', model: 'smoke-model',
  authHeader: 'Authorization', authPrefix: 'Bearer ', headers: [{ name: 'X-Smoke', value: 'yes' }],
  verifySsl: false, proxy: '', timeoutSecs: 30, temperature: 0.1, maxTokens: 256,
};
fs.writeFileSync(path.join(configDir, 'ai-settings.json'), JSON.stringify(aiSettings));

// 3. WebDriver session through tauri-driver.
const driver = spawn('tauri-driver', [], { stdio: 'inherit' });
const WD = 'http://127.0.0.1:4444';
async function wd(method, url, body) {
  const r = await fetch(WD + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || j.value?.error) throw new Error(`${method} ${url}: ${JSON.stringify(j.value).slice(0, 500)}`);
  return j.value;
}
async function waitFor(what, fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (Date.now() > end) throw e; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
await waitFor('tauri-driver', () => fetch(WD + '/status').then((r) => r.ok));

let sid;
const results = {};
const js = (script, args = []) => wd('POST', `/session/${sid}/execute/sync`, { script, args });
const jsAsync = (script, args = []) => wd('POST', `/session/${sid}/execute/async`, { script, args });
// Graphic Walker renders inside shadow roots, which neither querySelector nor WebDriver's
// element search pierce, so look elements up with a recursive query in the page.
const DEEP = `const deep = (root, css) => { const hit = root.querySelector(css); if (hit) return hit;
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const r = deep(el.shadowRoot, css); if (r) return r; }
  return null; };`;
const exists = (css) => js(`${DEEP} return !!deep(document, arguments[0]);`, [css]);
const find = async (css) => {
  const el = await js(`${DEEP} return deep(document, arguments[0]);`, [css]);
  if (!el) throw new Error(`element not found: ${css}`);
  return Object.values(el)[0];
};
async function screenshot(name) {
  try { fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(await wd('GET', `/session/${sid}/screenshot`), 'base64')); } catch {}
}

try {
  const t0 = Date.now();
  sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: path.resolve(exe) } } } })).sessionId;
  await waitFor('app shell', () => exists('.empty.drop'));
  results.startupMs = Date.now() - t0;
  log('app shell visible after', results.startupMs, 'ms');

  // Load a CSV through the real file input.
  await js('document.querySelector("input[type=file]").hidden = false');
  await wd('POST', `/session/${sid}/element/${await find('input[type=file]')}/value`, { text: path.join(root, 'tests/fixtures/sales.csv') });
  await js('document.querySelector("input[type=file]").hidden = true');
  await waitFor('dataset loaded', () => js('return document.querySelector("header select")?.textContent.includes("5,000 rows")'));
  log('CSV loaded');

  // Ask the AI for a chart; the request goes through the Rust proxy to the self-signed HTTPS mock.
  await waitFor('Graphic Walker', () => exists('#askviz_ask'), 60_000);
  const input = await find('input[placeholder^="What visualization"]');
  await wd('POST', `/session/${sid}/element/${input}/value`, { text: 'sales by region' });
  await wd('POST', `/session/${sid}/element/${await find('#askviz_ask')}/click`, {});
  await waitFor('AI chart', () => js(`${DEEP} const c = deep(document, '.vega-embed canvas, .vega-embed svg');
    const r = c?.getBoundingClientRect(); return !!r && r.width > 100 && r.height > 100;`), 30_000);
  await new Promise((r) => setTimeout(r, 1500));
  await screenshot('chart');
  const req = aiRequests[0];
  if (!req) throw new Error('the AI endpoint was not called');
  if (req.url !== '/v1/chat/completions') throw new Error(`unexpected AI path ${req.url}`);
  if (req.headers['x-smoke'] !== 'yes') throw new Error('custom header missing');
  if (req.body.includes('East') || req.body.includes('110.54')) throw new Error('row values were sent to the AI');
  log('AI chart rendered via HTTPS with SSL verification off; custom header sent; no row values sent');

  // With "Verify SSL" on, the self-signed certificate must be rejected.
  const verifyOn = await jsAsync(
    'const done = arguments[arguments.length - 1];' +
    'window.__TAURI_INTERNALS__.invoke("test_ai", { settings: arguments[0], apiKey: null }).then(() => done("accepted"), (e) => done(String(e)));',
    [{ ...aiSettings, verifySsl: true }],
  );
  if (verifyOn === 'accepted' || !/certificate|SSL|TLS/i.test(verifyOn)) throw new Error(`verify-on not rejected: ${verifyOn}`);
  log('Verify SSL on rejects the self-signed certificate');

  // Built-in basemap tile through the tiles: protocol (loaded as an image, like the map does).
  const tile = await jsAsync(
    'const done = arguments[arguments.length - 1];' +
    'const img = new Image();' +
    'img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight, src: img.src });' +
    'img.onerror = () => done({ error: "failed to load " + img.src });' +
    'img.src = window.__TAURI_INTERNALS__.convertFileSrc("", "tiles") + "3/6/3?v=smoke";',
  );
  if (tile.w !== 256 || tile.h !== 256) throw new Error(`tile endpoint: ${JSON.stringify(tile)}`);
  log('basemap tile OK:', JSON.stringify(tile));
  results.ok = true;
} catch (e) {
  results.ok = false;
  results.error = String(e?.stack ?? e);
  console.error(e);
  await screenshot('failure');
} finally {
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  if (sid) await wd('DELETE', `/session/${sid}`).catch(() => {});
  driver.kill();
  server.close();
}
process.exit(results.ok ? 0 : 1);
