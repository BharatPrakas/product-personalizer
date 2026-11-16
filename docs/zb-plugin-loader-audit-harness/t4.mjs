import { start, run, PROD, rules, hits } from './lib.mjs';
const { browser, close } = await start();
const M = (o) => ({ status: 200, type: 'application/json', body: JSON.stringify(o) });
const GOOD = { elementName: 'zb-personalization-admin', script: 'store-admin.js' };
const setMan = (base, e) => rules.set(`14700/${base}/manifest.json`, M({ production: { storeadmin: e } }));
setMan('product-personalization', GOOD); setMan('plugin-b', GOOD);

// P1 perf + L1 events/screenshot + cycles
{
  const page = await browser.newPage(); const logs = []; page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:14300/');
  const cdp = await page.createCDPSession(); await cdp.send('Performance.enable');
  const perf = await page.evaluate(async (env) => {
    const t0 = performance.now(); const m = window.host.mount(env, 'product-personalization');
    while (m.c.pageDetails.isLoading) await new Promise((r) => setTimeout(r, 5));
    const tLoaderFailed = performance.now() - t0;
    while (!customElements.get('zb-personalization-admin')) await new Promise((r) => setTimeout(r, 5));
    const tDefined = performance.now() - t0;
    const res = performance.getEntriesByType('resource').filter((e) => /14700/.test(e.name));
    return { loaderGaveUpAfterMs: Math.round(tLoaderFailed), tagDefinedAfterMs: Math.round(tDefined), requests: res.length, kBTransferred: +(res.reduce((s, e) => s + e.encodedBodySize, 0) / 1024).toFixed(1), files: res.map((e) => e.name.split('/').pop()) };
  }, PROD);
  console.log('P1 first visit (admin entry):', JSON.stringify(perf));
  // second visit mounts successfully; observe events with NO props set (host passes only zbService)
  const vis = await page.evaluate(async (env) => {
    const m = window.host.mount(env, 'product-personalization');
    while (m.c.pageDetails.isLoading) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 2500));
    const el = m.c.currentElement;
    return { ready: m.c.pageDetails.isPluginReady, elProps: { apiBaseUrl: el.apiBaseUrl, authToken: el.authToken, productCatalog: el.productCatalog, view: el.view, persistence: el.persistence, zbService: typeof el.zbService }, rect: el.getBoundingClientRect().toJSON(), events: window.__events.map((e) => e.type + (e.detail?.code ? ':' + e.detail.code : '')), hasShadow: !!el.shadowRoot, headStyles: document.head.querySelectorAll('style').length, text: (el.shadowRoot ?? el).textContent.replace(/\s+/g, ' ').slice(0, 160) };
  }, PROD);
  console.log('L1 second visit, host props only zbService:', JSON.stringify(vis));
  await page.screenshot({ path: 'admin-mounted.png' });
  // L3 mount/unmount cycles
  await cdp.send('HeapProfiler.collectGarbage');
  const h0 = (await page.metrics()).JSHeapUsedSize;
  const cyc = await page.evaluate(async (env) => {
    const ids = new Set(); const out = [];
    for (let i = 0; i < 15; i++) {
      const m = window.host.mount(env, 'product-personalization');
      while (m.c.pageDetails.isLoading) await new Promise((r) => setTimeout(r, 5));
      ids.add(m.c.currentElement); await new Promise((r) => setTimeout(r, 150));
      m.c.ngOnDestroy(); m.container.remove(); await new Promise((r) => setTimeout(r, 100));
    }
    return { distinctInstances: ids.size, liveElementsInDom: document.querySelectorAll('zb-personalization-admin').length, scriptTags: document.querySelectorAll('script[data-custom-plugin-script]').length };
  }, PROD);
  await cdp.send('HeapProfiler.collectGarbage'); await new Promise((r) => setTimeout(r, 500)); await cdp.send('HeapProfiler.collectGarbage');
  const h1 = (await page.metrics()).JSHeapUsedSize;
  console.log('L3 15 mount/unmount cycles:', JSON.stringify(cyc), 'heap delta kB after GC:', Math.round((h1 - h0) / 1024), '(h0', Math.round(h0 / 1024), 'kB)');
  console.log('   console during run:', logs.filter((l) => !/favicon|404/.test(l)).slice(0, 4));
}
// F11 stale-load race: A slow, then switch to plugin-b
{
  rules.set('14700/product-personalization/manifest.json', { ...M({ production: { storeadmin: GOOD } }), delay: 1200 });
  const page = await browser.newPage(); await page.goto('http://localhost:14300/');
  const out = await page.evaluate(async (env) => {
    const m = window.host.mount(env, 'product-personalization');
    await new Promise((r) => setTimeout(r, 100));
    m.params.next({ get: (k) => (k === 'pluginName' ? 'plugin-b' : null) });   // user navigates to another plugin
    await new Promise((r) => setTimeout(r, 2500));
    return { pluginName: m.c.pageDetails.pluginName, err: m.c.pageDetails.errorMessage, ready: m.c.pageDetails.isPluginReady, scripts: [...document.querySelectorAll('script[data-custom-plugin-script]')].map((s) => s.src.split('/').slice(-2).join('/')) , container: m.container.innerHTML.slice(0, 60) };
  }, PROD);
  console.log('F11 A (slow) then B:', JSON.stringify(out), '| plugin A script ever requested:', hits.some((h) => /product-personalization\/store-admin/.test(h)));
  rules.set('14700/product-personalization/manifest.json', M({ production: { storeadmin: GOOD } }));
}
// F12 destroy during load
{
  rules.set('14700/product-personalization/store-admin.js', { delay: 1000, ...{} });
  rules.delete('14700/product-personalization/store-admin.js');
  rules.set('14700/product-personalization/manifest.json', { ...M({ production: { storeadmin: GOOD } }), delay: 600 });
  const page = await browser.newPage(); await page.goto('http://localhost:14300/');
  const out = await page.evaluate(async (env) => {
    const m = window.host.mount(env, 'product-personalization'); await new Promise((r) => setTimeout(r, 100));
    m.c.ngOnDestroy(); await new Promise((r) => setTimeout(r, 2000));
    return { container: m.container.innerHTML, scriptsInjectedAfterDestroy: document.querySelectorAll('script[data-custom-plugin-script]').length, details: m.c.pageDetails };
  }, PROD);
  console.log('F12 destroy during manifest fetch:', JSON.stringify(out));
  rules.set('14700/product-personalization/manifest.json', M({ production: { storeadmin: GOOD } }));
}
// F9b tag conflict: plugin-b (different bundle URL) after A registered the tag
{
  const page = await browser.newPage(); await page.goto('http://localhost:14300/');
  const out = await page.evaluate(async (env) => {
    const wait = async (m) => { while (m.c.pageDetails.isLoading) await new Promise((r) => setTimeout(r, 5)); };
    let a = window.host.mount(env, 'product-personalization'); await wait(a); await new Promise((r) => setTimeout(r, 800)); a.c.ngOnDestroy();
    const b = window.host.mount(env, 'plugin-b'); await wait(b); await new Promise((r) => setTimeout(r, 1500));
    return { bReady: b.c.pageDetails.isPluginReady, bErr: b.c.pageDetails.errorMessage, scripts: [...document.querySelectorAll('script[data-custom-plugin-script]')].map((s) => s.src.split('/').slice(-2).join('/')) };
  }, PROD);
  console.log('F9b same tag from 2 bundle URLs:', JSON.stringify(out));
}
await close();
