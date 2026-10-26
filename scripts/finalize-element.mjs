/**
 * Runs after `ng run product-personalizer:build-element`. Turns the raw Angular output into the
 * deployable `dist/product-personalization/` folder:
 *
 *  - storefront.js / store-admin.js  stable, un-hashed module entries (one per custom element)
 *  - main*.js, chunk-*.js            content-hashed bundles; Angular's runtime and shared code live
 *                                    in chunks both elements import, each element's own code is a
 *                                    lazy chunk that is only fetched when its entry is loaded
 *  - types/                          public .d.ts files (models + both element contracts)
 *  - integration-demo/               the framework-free host pages
 *  - MANIFEST.json                   every file with size and sha256, grouped by role, plus the
 *                                    per-entry download graph used for the bundle budgets
 *  - ../element/product-customizer.js  thin compatibility shim for the former output location
 *
 * Budgets (the Angular builder only sees the tiny shared façade as "initial", so they are
 * enforced here on the real per-entry graph):
 *   storefront  warning 400 kB, error 700 kB   (raw bytes, same numbers as the former build)
 *   admin       warning 1.4 MB, error 2.0 MB   (editor, dialogs and import/export are lazy chunks)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'product-personalization');
const legacyOut = join(root, 'dist', 'element');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const ALL_ENTRIES = [
  {
    file: 'storefront.js',
    tag: 'zb-product-customizer',
    loader: 'loadStorefront',
    budget: { warn: 400 * 1024, error: 700 * 1024 },
  },
  {
    file: 'store-admin.js',
    tag: 'zb-personalization-admin',
    loader: 'loadAdmin',
    budget: { warn: 1400 * 1024, error: 2000 * 1024 },
  },
];

if (!existsSync(out))
  throw new Error(
    'dist/product-personalization not found; run the Angular build-element target first',
  );

// 1. Stable entries -> hashed façade bundle.
const main = readdirSync(out).find((f) => /^main(-[A-Za-z0-9]+)?\.js$/.test(f));
if (!main) throw new Error('main bundle not found in dist/product-personalization');
const facade = readFileSync(join(out, main), 'utf8');
const ENTRIES = ALL_ENTRIES;
for (const entry of ENTRIES) {
  if (!new RegExp(`\\b${entry.loader}\\b`).test(facade))
    throw new Error(
      `${entry.loader} is not exported by ${main}; is src/main.elements.ts complete?`,
    );
}
for (const entry of ENTRIES) {
  writeFileSync(
    join(out, entry.file),
    `// Stable entry for <${entry.tag}>. Loads the generated bundles (cache this file briefly; the bundles are content-hashed).\n` +
      `import { ${entry.loader} } from './${main}';\n${entry.loader}();\n`,
  );
}

// 2. Public type declarations (models + element contracts).
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.types.json'],
  { cwd: root, stdio: 'inherit' },
);

// 3. Plain-HTML host demos.
cpSync(join(root, 'integration-demo'), join(out, 'integration-demo'), { recursive: true });

// 4. Compatibility shim for consumers of the former dist/element/ location.
rmSync(legacyOut, { recursive: true, force: true });
mkdirSync(legacyOut, { recursive: true });
writeFileSync(
  join(legacyOut, 'product-customizer.js'),
  '// Compatibility shim. The element now ships from ../product-personalization/ (storefront.js).\n' +
    '// Deploy the whole product-personalization folder and point your page at storefront.js instead.\n' +
    "import '../product-personalization/storefront.js';\n",
);

// 5. Download graph per entry + budgets.
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

// Minified output may quote specifiers with ", ' or `.
const STATIC_IMPORT =
  /(?:^|[;\n}])\s*(?:import|export)\s*(?:[^'"`()]*?\s*from\s*)?["'`](\.\/[^"'`]+\.js)["'`]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["'`](\.\/[^"'`]+\.js)["'`]\s*\)/g;
const imports = (file, re) =>
  [...readFileSync(join(out, file), 'utf8').matchAll(re)].map((m) => m[1].slice(2));

/** Local function name behind an exported alias, e.g. `export{o as loadStorefront}`. */
function localName(alias) {
  const exp = /export\s*\{([^}]*)\}/.exec(facade);
  if (!exp) return alias;
  for (const part of exp[1].split(',')) {
    const [local, as] = part.trim().split(/\s+as\s+/);
    if ((as ?? local) === alias) return local;
  }
  return alias;
}

/** Chunks the façade function behind `alias` loads with import(); found by brace matching so it works on minified output. */
function loaderImports(alias) {
  const name = localName(alias);
  const start = new RegExp(`function\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`).exec(facade);
  if (!start) throw new Error(`cannot find ${alias}() in ${main}`);
  const open = facade.indexOf('{', start.index);
  let depth = 0;
  let end = open;
  for (; end < facade.length; end++) {
    if (facade[end] === '{') depth++;
    else if (facade[end] === '}' && --depth === 0) break;
  }
  return [...facade.slice(open, end + 1).matchAll(DYNAMIC_IMPORT)].map((m) => m[1].slice(2));
}

/**
 * What loading `entry` downloads up-front: the entry, its static imports (transitively) and the
 * single lazy chunk the façade's loader() resolves to. Chunks reached only through further dynamic
 * imports (routes, dialogs, import/export) are not part of the initial download.
 */
function initialGraph(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    imports(file, STATIC_IMPORT).forEach(visit);
  };
  visit(entry.file);
  for (const target of loaderImports(entry.loader)) visit(target);
  return [...seen].sort();
}

// The storefront must never ship editor / admin code (it is downloaded by every shopper).
const FORBIDDEN_IN_STOREFRONT = ['zb-personalization-admin', 'config-published', 'mapping-changed'];

const sizeOf = (file) => statSync(join(out, file)).size;
const entries = {};
let failed = false;
for (const entry of ENTRIES) {
  const files = initialGraph(entry);
  const bytes = files.reduce((sum, f) => sum + sizeOf(f), 0);
  entries[entry.file] = { tag: entry.tag, initialBytes: bytes, initialFiles: files };
  if (entry.file === 'storefront.js') {
    for (const f of files) {
      const text = readFileSync(join(out, f), 'utf8');
      for (const marker of FORBIDDEN_IN_STOREFRONT) {
        if (text.includes(marker)) {
          console.error(`STOREFRONT PURITY ERROR: ${f} contains admin code ("${marker}")`);
          failed = true;
        }
      }
    }
  }
  const kb = (bytes / 1024).toFixed(1);
  if (bytes > entry.budget.error) {
    console.error(
      `BUDGET ERROR ${entry.file}: ${kb} kB exceeds ${(entry.budget.error / 1024).toFixed(0)} kB`,
    );
    failed = true;
  } else if (bytes > entry.budget.warn) {
    console.warn(
      `budget warning ${entry.file}: ${kb} kB exceeds ${(entry.budget.warn / 1024).toFixed(0)} kB`,
    );
  }
}

// 6. Manifest.
const entryFiles = new Set(ENTRIES.map((e) => e.file));
const role = (file) => {
  if (entryFiles.has(file)) return 'entry';
  if (file === '3rdpartylicenses.txt') return 'license';
  if (/^(main|chunk|styles).*\.(js|css)$/.test(file)) return 'runtime';
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
  .filter((f) => f.path !== 'MANIFEST.json' && !f.path.endsWith('.map'))
  .sort((a, b) => a.path.localeCompare(b.path));

writeFileSync(
  join(out, 'MANIFEST.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      elements: ENTRIES.map((e) => ({ tag: e.tag, entry: e.file })),
      compatibility: {
        note: 'dist/element/product-customizer.js is a shim that imports ../product-personalization/storefront.js. Deploy the whole product-personalization folder; the shim is optional.',
      },
      note: 'Deploy every file with role "entry" and "runtime" next to each other, plus the "license" file (third-party notices). "contract" files are for developers; "demo-*" files are samples and can be replaced by your own configuration and assets.',
      entries,
      files,
    },
    null,
    2,
  ) + '\n',
);

const total = files.reduce((sum, f) => sum + f.bytes, 0);
console.log(
  `product-personalization: ${files.length} files, ${(total / 1024).toFixed(0)} KB total`,
);
for (const [file, info] of Object.entries(entries))
  console.log(
    `  ${file.padEnd(16)} initial download ${(info.initialBytes / 1024).toFixed(1)} kB in ${info.initialFiles.length} files`,
  );
if (failed) process.exit(1);
