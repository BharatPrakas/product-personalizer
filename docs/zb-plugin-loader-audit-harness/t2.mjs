import { start, run, PROD, rules, hits } from './lib.mjs';
const { browser, close } = await start();
const M = (o) => ({ status: 200, type: 'application/json', body: typeof o === 'string' ? o : JSON.stringify(o) });
const man = (entry, base = 'product-personalization') => rules.set(`14700/${base}/manifest.json`, M({ production: { storeadmin: entry } }));
const GOOD = { elementName: 'zb-personalization-admin', script: 'store-admin.js' };
const sum = (id, r) => console.log(id.padEnd(34), '=>', r.result.pageDetails.hasError ? 'ERROR "' + r.result.pageDetails.errorMessage + '"' : 'READY', '| defNow', r.result.tagDefinedNow, '| defLater', r.later.tagDefinedLater, '| container:', JSON.stringify(r.result.html.slice(0, 50)), '| logs:', JSON.stringify(r.logs.slice(0, 2)));
const reset = () => { rules.clear(); hits.length = 0; };

reset(); rules.set('14700/product-personalization/manifest.json', { status: 404 });
sum('F1 manifest 404', await run(browser, PROD, 'product-personalization'));
reset(); rules.set('14700/product-personalization/manifest.json', { status: 200, type: 'text/html', body: '<html>spa fallback</html>' });
sum('F2 manifest invalid JSON/HTML', await run(browser, PROD, 'product-personalization'));
reset(); man({ elementName: 'zb-personalization-admin' });
sum('F3 entry missing script', await run(browser, PROD, 'product-personalization'));
reset(); man({ ...GOOD, script: 'nope.js' });
sum('F4 entry file 404', await run(browser, PROD, 'product-personalization'));
reset(); man(GOOD); rules.set('14700/product-personalization/store-admin.js', { status: 200, type: 'text/html', body: '<!doctype html><html>SPA fallback</html>' });
sum('F5 HTML served as JS', await run(browser, PROD, 'product-personalization'));
reset(); man(GOOD); rules.set('14700/product-personalization/chunk-cqP4L7IF.js', { status: 404 });
{ const r = await run(browser, PROD, 'product-personalization', { wait: 3000 }); sum('F6 lazy chunk 404', r); console.log('   events:', r.later.events, 'console:', r.logs); }
reset(); man({ ...GOOD, styles: ['missing.css'] });
sum('F7 CSS 404', await run(browser, PROD, 'product-personalization'));
reset(); man({ elementName: 'zb-personalization-admin', script: 'http://localhost:14800/evil.js' });
{ const r = await run(browser, PROD, 'product-personalization', { after: (p) => p.evaluate(() => window.__pwned) }); sum('F8 foreign-origin script in manifest', r); console.log('   foreign code executed:', r.extra); }
reset(); man({ elementName: 'zb-personalization-admin', script: 'store-admin.js', styles: [] });
{ // F9 first vs second visit in same page
  const page = await browser.newPage(); await page.goto('http://localhost:14300/');
  const out = await page.evaluate(async (env) => {
    const res = [];
    for (let i = 0; i < 3; i++) {
      const m = window.host.mount(env, 'product-personalization');
      const s = performance.now(); while (m.c.pageDetails.isLoading && performance.now() - s < 5000) await new Promise((r) => setTimeout(r, 10));
      res.push({ visit: i + 1, ready: m.c.pageDetails.isPluginReady, err: m.c.pageDetails.errorMessage });
      m.c.ngOnDestroy(); m.container.remove();
      await new Promise((r) => setTimeout(r, 800));
    }
    return res;
  }, PROD);
  console.log('F9 first/second/third visit        =>', JSON.stringify(out));
}
reset();
{ // F10 URL composition with odd plugin names
  for (const n of ['..', 'a/../../x', 'product-personalization?x=1', '%2e%2e']) {
    const page = await browser.newPage(); await page.goto('http://localhost:14300/');
    hits.length = 0;
    await page.evaluate((env, n) => { window.host.mount(env, n); }, PROD, n);
    await new Promise((r) => setTimeout(r, 400));
    console.log('F10 pluginName', JSON.stringify(n).padEnd(32), '=> manifest request:', hits.filter((h) => /manifest/.test(h)));
  }
}
await close();
