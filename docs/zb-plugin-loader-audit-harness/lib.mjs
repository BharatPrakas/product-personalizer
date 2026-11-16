import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from '/home/centizen/Documents/Centizen Apps/product-personalizer/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
export const SP = path.dirname(new URL(import.meta.url).pathname);
const MIME = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html', '.txt': 'text/plain' };
export const rules = new Map(); // urlpath -> {status, body, type, delay}
export const hits = [];
function serve(root, port, cors = true) {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const p = decodeURIComponent(u.pathname);
    hits.push(port + p);
    const h = cors ? { 'Access-Control-Allow-Origin': '*' } : {};
    const r = rules.get(port + p);
    const go = () => {
      if (r && r.status !== undefined) { res.writeHead(r.status, { 'Content-Type': r.type ?? 'text/plain', ...h }); return res.end(r.body ?? ''); }
      let f = path.join(root, p === '/' ? 'index.html' : p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, h); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream', ...h }); fs.createReadStream(f).pipe(res);
    };
    r?.delay ? setTimeout(go, r.delay) : go();
  });
  return new Promise((ok) => s.listen(port, () => ok(s)));
}
export async function start() {
  const servers = [await serve(path.join(SP, 'site'), 14300, false), await serve(path.join(SP, 'bucket'), 14700), await serve(path.join(SP, 'bucket3'), 14800)];
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--js-flags=--expose-gc'] });
  return { browser, close: async () => { await browser.close(); servers.forEach((s) => s.close()); } };
}
export const PROD = { app: 'prod', awsFileUrl: 'http://localhost:14700/' };
export async function run(browser, env, name, { wait = 6000, after } = {}) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await page.goto('http://localhost:14300/', { waitUntil: 'load' });
  const result = await page.evaluate(async (env, name, wait) => {
    const t0 = performance.now();
    const m = window.host.mount(env, name);
    const start = performance.now();
    while (m.c.pageDetails.isLoading && performance.now() - start < wait) await new Promise((r) => setTimeout(r, 20));
    return { pageDetails: { ...m.c.pageDetails }, ms: Math.round(performance.now() - t0), html: m.container.innerHTML.slice(0, 120), tagDefinedNow: customElements.get('zb-personalization-admin') !== undefined };
  }, env, name, wait);
  // give async registration a chance to finish after the loader returned
  await new Promise((r) => setTimeout(r, 1500));
  const later = await page.evaluate(() => ({ tagDefinedLater: customElements.get('zb-personalization-admin') !== undefined, events: window.__events.map((e) => e.type + (e.detail?.code ? ':' + e.detail.code : '')) }));
  const extra = after ? await after(page) : undefined;
  return { page, result, later, logs, extra };
}
