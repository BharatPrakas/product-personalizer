import { build } from '/home/centizen/Documents/Centizen Apps/product-personalizer/node_modules/esbuild/lib/main.js';
import path from 'node:path';
const SP = path.dirname(new URL(import.meta.url).pathname);
const stub = path.join(SP, 'src/ng-stub.ts');
const rx = '/home/centizen/Documents/Centizen Apps/product-personalizer/node_modules';
await build({
  entryPoints: [path.join(SP, 'src/entry.ts')], bundle: true, format: 'esm', outfile: path.join(SP, 'site/harness.js'),
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
  nodePaths: [rx],
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /^(@angular\/|@zb\/|@zba\/)/ }, () => ({ path: stub }));
    b.onResolve({ filter: /services\/zb\.service$/ }, () => ({ path: path.join(SP, 'src/zb-service-stub.ts') }));
  }}],
  logLevel: 'info',
});
