import { start, run, rules } from './lib.mjs';
import fs from 'node:fs';
const { browser, close } = await start();
const m = fs.readFileSync('/home/centizen/Documents/Centizen Apps/product-personalizer/public/manifest.json','utf8').replaceAll('localhost:4600','localhost:14800');
rules.set('14800/manifest.json',{status:200,type:'application/json',body:m.replaceAll('localhost:14601','localhost:14800')});
const r = await run(browser, { app: 'local', customPluginLocalBaseUrl: 'http://localhost:14800' }, 'product-personalization', { wait: 8000, after: (p) => p.evaluate(() => ({ appRootInHost: !!document.querySelector('app-root'), headScripts: [...document.querySelectorAll('script[data-custom-plugin-script]')].map(s=>s.src), links: [...document.querySelectorAll('link[data-custom-plugin-style]')].map(s=>s.href) })) });
console.log(JSON.stringify({ pageDetails: r.result.pageDetails, defNow: r.result.tagDefinedNow, defLater: r.later.tagDefinedLater, logs: r.logs, extra: r.extra }, null, 1));
await close();
