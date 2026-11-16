import { start, run, PROD, rules } from './lib.mjs';
const { browser, close } = await start();
const show = (id, r) => console.log(id, JSON.stringify({ ...r.result, later: r.later, logs: r.logs.slice(0, 4), extra: r.extra }, null, 1));
// T1: actual shipped dist as-is
show('T1 actual dist (stale public/manifest.json)', await run(browser, PROD, 'product-personalization'));
// T2: corrected manifest that points at the real stable entry store-admin.js
rules.set('14700/product-personalization/manifest.json', { status: 200, type: 'application/json', body: JSON.stringify({ production: { storeadmin: { elementName: 'zb-personalization-admin', script: 'store-admin.js' } } }) });
show('T2 corrected manifest -> store-admin.js', await run(browser, PROD, 'product-personalization'));
// T3: manifest pointing at the hashed facade main-*.js (what stale manifest names)
rules.set('14700/product-personalization/manifest.json', { status: 200, type: 'application/json', body: JSON.stringify({ production: { storeadmin: { elementName: 'zb-personalization-admin', script: 'main-EN3ADEH5.js' } } }) });
show('T3 manifest -> hashed main facade', await run(browser, PROD, 'product-personalization'));
await close();
