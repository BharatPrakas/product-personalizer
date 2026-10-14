/**
 * Runs after `ng run product-personalizer:build-element`. Turns the raw Angular output into the
 * deployable `dist/element/` folder:
 *
 *  - product-customizer.js  stable, un-hashed module entry that imports the hashed bundle
 *  - types/                 public .d.ts files (models + element contract), emitted by tsc
 *  - integration-demo/      the framework-free host page
 *  - MANIFEST.json          every file with size and sha256, grouped by role
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'element');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!existsSync(out))
  throw new Error('dist/element not found; run the Angular build-element target first');

// 1. Stable entry -> hashed main bundle.
const main = readdirSync(out).find((f) => /^main(-[A-Z0-9]+)?\.js$/.test(f));
if (!main) throw new Error('main bundle not found in dist/element');
writeFileSync(
  join(out, 'product-customizer.js'),
  `// Stable entry for <zb-product-customizer>. Loads the generated bundle below (cache this file briefly; the bundle is content-hashed).\nimport './${main}';\n`,
);

// 2. Public type declarations.
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.types.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);

// 3. Plain-HTML host demo.
cpSync(join(root, 'integration-demo'), join(out, 'integration-demo'), { recursive: true });

// 4. Manifest.
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const role = (file) => {
  if (file === 'product-customizer.js') return 'entry';
  if (file === '3rdpartylicenses.txt') return 'license';
  if (/^(main|chunk)-.*\.js$/.test(file) || /^(main|chunk|styles).*\.(js|css)$/.test(file))
    return 'runtime';
  if (file.startsWith('data/') || file.startsWith('assets/')) return 'demo-asset';
  if (file.startsWith('integration-demo/')) return 'demo-page';
  if (file.startsWith('types/') || file.startsWith('schema/')) return 'contract';
  return 'other';
};

const files = walk(out)
  .map((path) => {
    const name = relative(out, path).split('\\').join('/');
    const bytes = readFileSync(path);
    return {
      path: name,
      role: role(name),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  })
  .filter((f) => f.path !== 'MANIFEST.json')
  .sort((a, b) => a.path.localeCompare(b.path));

writeFileSync(
  join(out, 'MANIFEST.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      element: 'zb-product-customizer',
      entry: 'product-customizer.js',
      note: 'Deploy every file with role "entry" and "runtime" next to each other, plus the "license" file (third-party notices). "contract" files are for developers; "demo-*" files are samples and can be replaced by your own configuration and assets.',
      files,
    },
    null,
    2,
  ) + '\n',
);

const total = files.reduce((sum, f) => sum + f.bytes, 0);
const runtime = files.filter((f) => f.role === 'entry' || f.role === 'runtime');
console.log(`element: ${files.length} files, ${(total / 1024).toFixed(0)} KB total`);
for (const f of runtime)
  console.log(`  ${f.role.padEnd(8)} ${f.path}  ${(f.bytes / 1024).toFixed(1)} KB`);
