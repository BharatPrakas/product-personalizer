/**
 * Minimal static file server for local demos and the browser tests. No dependencies.
 *
 *   node scripts/serve-static.mjs <dir> [port] [--mount /prefix] [--cors]
 *
 *   --mount /a/b   serve the directory under a nested path (tests relative asset resolution)
 *   --cors         add `Access-Control-Allow-Origin: *` (omit it to test missing-CORS behaviour)
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
};

/**
 * Request handler for one directory. Returns false (without responding) when the request is
 * outside `mount`, so several handlers can be chained on one origin.
 */
export function createStaticHandler({ root, mount = '', cors = false, headers = {} }) {
  const base = resolve(root);
  const prefix = mount.replace(/\/$/, '');
  return (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
        ...headers,
      });
      res.end(body);
    };
    try {
      let path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      if (prefix) {
        if (path !== prefix && !path.startsWith(`${prefix}/`)) return false;
        path = path.slice(prefix.length) || '/';
      }
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(base, path));
      if (file !== base && !file.startsWith(base + sep)) return (send(403, 'Forbidden'), true);
      if (!existsSync(file) || !statSync(file).isFile()) return (send(404, 'Not found'), true);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': statSync(file).size,
        'Cache-Control': 'no-store',
        ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
        ...headers,
      });
      if (req.method === 'HEAD') return (res.end(), true);
      createReadStream(file).pipe(res);
      return true;
    } catch {
      send(400, 'Bad request');
      return true;
    }
  };
}

export function createStaticServer(options) {
  const handler = createStaticHandler(options);
  return createServer((req, res) => {
    if (handler(req, res) === false) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--mount');
  const [dir = 'dist/element', port = '4300'] = positional;
  const mount = value('--mount') ?? '';
  const server = createStaticServer({ root: dir, mount, cors: flag('--cors') });
  server.listen(Number(port), () => {
    console.log(`Serving ${resolve(dir)} at http://localhost:${port}${mount}/`);
    console.log(`Plain HTML demo: http://localhost:${port}${mount}/integration-demo/`);
  });
}
