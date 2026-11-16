import http from 'node:http';
import fs from 'node:fs';
import { start, rules } from './lib.mjs';

const ENV = { app: 'dev', awsFileUrl: 'http://localhost:14700/' };
const api = { log: [] };
const apiServer = http.createServer((req, res) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type,x-request-id', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
  const auth = req.headers.authorization ?? null;
  const entry = { m: req.method, p: new URL(req.url, 'http://x').pathname.replace('/api/v1/plugins/personalization', ''), auth };
  api.log.push(entry);
  if (auth !== 'Bearer fresh') { entry.status = 401; res.writeHead(401, { 'Content-Type': 'application/json', ...h }); return res.end(JSON.stringify({ error: { code: 'unauthenticated', message: 'nope' } })); }
  entry.status = 200; res.writeHead(200, { 'Content-Type': 'application/json', ...h });
  const cfg = { schemaVersion: 1, id: 'cfg1', version: 1, status: 'published', product: { name: 'Tote design' }, variants: [], mockups: [], printableAreas: [], artworks: [], fonts: [], fields: [] };
  const isConfigs = entry.p === '/configs';
  res.end(JSON.stringify({ data: isConfigs ? [{ id: 'cfg1', draft: { ...cfg, status: 'draft' }, published: cfg, createdAt: 1, updatedAt: 2, publishedAt: 2, archivedAt: null }] : [], meta: { pagination: { page: 1, pageSize: 100, total: isConfigs ? 1 : 0, totalPages: isConfigs ? 1 : 0 } }, requestId: 'r' }));
});
await new Promise((ok) => apiServer.listen(14900, ok));

const manifest = JSON.parse(fs.readFileSync('bucket/personalizedproduct/manifest.json', 'utf8'));
console.log('manifest production.storeadmin.config (as shipped):', JSON.stringify(manifest.production.storeadmin.config));
manifest.production.storeadmin.config.apiBaseUrl = 'http://localhost:14900'; // point the shipped manifest at the fake Worker
rules.set('14700/personalizedproduct/manifest.json', { status: 200, type: 'application/json', body: JSON.stringify(manifest) });

const { browser, close } = await start();

async function scenario(title, withSdk) {
  api.log.length = 0;
  const page = await browser.newPage(); const logs = [];
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:14300/');
  const out = await page.evaluate(async (env, withSdk) => {
    window.__sdk = { auth: [], search: [] };
    const zb = withSdk ? {
      version: 1,
      auth: { getAccessToken: async (r) => { window.__sdk.auth.push(r ?? null); return r?.forceRefresh ? { token: 'fresh', expiresAt: Date.now() + 300000 } : { token: 'stale', expiresAt: Date.now() + 300000 }; } },
      products: { search: async (q) => { window.__sdk.search.push(q ?? null); return { items: [{ id: '42', title: 'Canvas Tote', sku: 'CT-1' }, { id: '43', title: 'Enamel Mug' }], total: 2 }; } },
      core: {},
    } : {}; // the old empty facade
    const t0 = performance.now();
    const m = window.host.mount(env, 'personalizedproduct', zb);
    while (m.c.pageDetails.isLoading && performance.now() - t0 < 9000) await new Promise((r) => setTimeout(r, 20));
    const el = m.c.currentElement;
    const res = { ready: m.c.pageDetails.isPluginReady, err: m.c.pageDetails.errorMessage, loadedInMs: Math.round(performance.now() - t0) };
    if (!el) return res;
    await new Promise((r) => setTimeout(r, 1500));
    res.props = { apiBaseUrl: el.apiBaseUrl, persistence: el.persistence, authToken: el.authToken, sameSdk: el.zbService === zb };
    res.chip = el.shadowRoot?.querySelector('.storage-chip')?.textContent.trim();
    el.view = 'mapping';
    await new Promise((r) => setTimeout(r, 1800));
    res.shadowText = [...el.shadowRoot.querySelectorAll('main, [role=status], .notice')].map((n) => n.textContent).join(' | ').replace(/\s+/g, ' ');
    res.sdk = window.__sdk;
    res.events = window.__events.map((e) => e.type + (e.detail?.code ? ':' + e.detail.code : ''));
    return res;
  }, ENV, withSdk);
  const shadowText = out.shadowText; delete out.shadowText;
  out.mappingShowsSdkProduct = /Canvas Tote/.test(shadowText ?? '');
  out.mappingText = (shadowText ?? '').slice(0, 260);
  console.log(`\n== ${title}\n` + JSON.stringify(out, null, 1));
  console.log('API requests seen by the fake Worker:', JSON.stringify(api.log.map((r) => `${r.m} ${r.p} [${r.auth ?? 'no auth'}] -> ${r.status}`)));
  console.log('console:', JSON.stringify(logs.filter((l) => !/favicon|404/.test(l)).slice(0, 4)));
  await page.screenshot({ path: `e2e-${withSdk ? 'sdk' : 'nosdk'}.png` });
}
await scenario('A: host with SDK-shaped zbService (token + products via SDK)', true);
await scenario('B: host with the old empty zbService (no SDK)', false);
await close(); apiServer.close();
