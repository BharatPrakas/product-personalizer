import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
// @ts-expect-error plain ESM script without types
import { createStaticHandler } from '../../scripts/serve-static.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELEMENT_DIR = join(root, 'dist', 'product-personalization');
const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), 'host');
export const NESTED = '/nested/path/customizer';

type Handler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) => boolean;

function listen(handlers: Handler[], port = 0): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    for (const handler of handlers) if (handler(req, res) !== false) return;
    res.writeHead(404).end('Not found');
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

/** A scriptable stand-in for the personalization API's public storefront endpoint. */
export interface ShopperRequest {
  /** `uploads` or `customizations`. */
  endpoint: 'uploads' | 'customizations';
  method: string;
  query: Record<string, string>;
  contentType: string | undefined;
  bodySize: number;
  /** Parsed JSON body (customizations only). */
  json?: any;
}

/** Scriptable stand-in for the shopper endpoints (private uploads, save customization). */
export interface MockShopper {
  requests: ShopperRequest[];
  /** Override the next answers; unset = success with sequential ids (`asset-1`, `cz-1`, ...). */
  uploadAnswer?: { status?: number; body?: unknown };
  createAnswer?: { status?: number; body?: unknown };
  /** Delay before answering a customization save (to test concurrent calls). */
  createDelayMs?: number;
}

export interface MockApi {
  shopper: MockShopper;
  /** productId (or '*') -> what the endpoint answers. */
  responses: Map<string, { status?: number; body?: unknown; delayMs?: number }>;
  requests: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[];
  /**
   * `"GET /api/v1/plugins/personalization/configs"` -> answer, for the admin API (path as sent, so
   * still percent-encoded). `bytes` answers with a binary file of `contentType` instead of JSON.
   */
  admin: Map<string, { status?: number; body?: unknown; bytes?: Buffer; contentType?: string }>;
  reset(): void;
}

const SHOPPER = /^\/api\/v1\/storefront\/personalization\/(uploads|customizations)$/;
const STOREFRONT = /^\/api\/v1\/storefront\/personalization\/products\/([^/]+)\/config$/;

function createMockApi(): { api: MockApi; handler: Handler } {
  let assetCounter = 0;
  let customizationCounter = 0;
  const api: MockApi = {
    shopper: { requests: [] },
    responses: new Map(),
    requests: [],
    admin: new Map(),
    reset() {
      assetCounter = 0;
      customizationCounter = 0;
      api.shopper = { requests: [] };
      api.responses.clear();
      api.admin.clear();
      api.requests.length = 0;
    },
  };
  const handler: Handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/v1/plugins/personalization/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        });
        res.end();
        return true;
      }
      api.requests.push({ method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers });
      const answer = api.admin.get(`${req.method} ${url.pathname}`) ?? { status: 404, body: { error: { code: 'not_found' } } };
      if (answer.bytes) {
        res.writeHead(answer.status ?? 200, { 'content-type': answer.contentType ?? 'application/octet-stream', 'cache-control': 'private, no-store' });
        res.end(answer.bytes);
        return true;
      }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(answer.body ?? { data: [] }));
      return true;
    }
    const shopper = SHOPPER.exec(url.pathname);
    if (shopper) {
      const endpoint = shopper[1] as 'uploads' | 'customizations';
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
        res.end();
        return true;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const entry: ShopperRequest = {
          endpoint,
          method: req.method ?? 'POST',
          query: Object.fromEntries(url.searchParams),
          contentType: req.headers['content-type'],
          bodySize: body.length,
        };
        if (endpoint === 'customizations') entry.json = JSON.parse(body.toString('utf8') || '{}');
        api.shopper.requests.push(entry);
        const answer = endpoint === 'uploads' ? api.shopper.uploadAnswer : api.shopper.createAnswer;
        const reply = () => {
          if (answer) {
            res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify(answer.body ?? {}));
            return;
          }
          const data =
            endpoint === 'uploads'
              ? { assetId: `asset-${++assetCounter}`, uploadToken: `utok-${assetCounter}`, kind: entry.query['kind'] }
              : {
                  customizationId: `cz-${++customizationCounter}`,
                  status: 'saved',
                  accessToken: `atok-${customizationCounter}`,
                  accessTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
                };
          res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ data }));
        };
        if (endpoint === 'customizations' && api.shopper.createDelayMs) setTimeout(reply, api.shopper.createDelayMs);
        else reply();
      });
      return true;
    }
    const match = STOREFRONT.exec(url.pathname);
    if (!match) return false;
    api.requests.push({ method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers });
    const id = decodeURIComponent(match[1]);
    const response = api.responses.get(id) ?? api.responses.get('*') ?? { body: { data: { personalizable: false } } };
    setTimeout(() => {
      res.writeHead(response.status ?? 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(response.body ?? {}));
    }, response.delayMs ?? 0);
    return true;
  };
  return { api, handler };
}

export interface Environment {
  /** Scriptable personalization API served from the page origin. */
  api: MockApi;
  /** Page origin: host pages at `/host.html`, the element bundle under NESTED. */
  origin: string;
  /** `${origin}${NESTED}`: where the element, its data and its assets live. */
  elementBase: string;
  /** Another origin serving the same files WITH CORS headers. */
  corsOrigin: string;
  /** Another origin serving the same files WITHOUT CORS headers. */
  noCorsOrigin: string;
  tmp: string;
  browser: Browser;
  close(): Promise<void>;
}

export async function startEnvironment(): Promise<Environment> {
  const mock = createMockApi();
  const main = await listen([
    mock.handler,
    createStaticHandler({ root: ELEMENT_DIR, mount: NESTED }),
    createStaticHandler({ root: HOST_DIR, mount: '' }),
  ], Number(process.env['ZB_E2E_PORT'] ?? 0));
  const cors = await listen([createStaticHandler({ root: ELEMENT_DIR, cors: true })]);
  const plain = await listen([createStaticHandler({ root: ELEMENT_DIR, cors: false })]);
  const tmp = mkdtempSync(join(tmpdir(), 'zbc-tests-'));
  const browser = await puppeteer.launch({
    executablePath: process.env['CHROME_PATH'] ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars'],
  });
  return {
    api: mock.api,
    origin: main.origin,
    elementBase: `${main.origin}${NESTED}`,
    corsOrigin: cors.origin,
    noCorsOrigin: plain.origin,
    tmp,
    browser,
    async close() {
      await browser.close();
      for (const { server } of [main, cors, plain]) server.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export interface HostPage {
  page: Page;
  consoleErrors: string[];
  pageErrors: string[];
}

export async function openHost(
  env: Environment,
  options: {
    query?: string;
    viewport?: { width: number; height: number; deviceScaleFactor?: number };
    page?: 'host.html' | 'host-csp.html';
  } = {},
): Promise<HostPage> {
  const page = await env.browser.newPage();
  await page.setViewport({ width: 1280, height: 1000, ...options.viewport });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${env.origin}/${options.page ?? 'host.html'}${options.query ?? ''}`);
  await page.waitForFunction(
    () => (window as unknown as { testHostReady?: boolean }).testHostReady === true,
  );

  // Every test page doubles as a framework health check: Angular's own error reporting
  // (NG0xxx assertions, "ERROR ..." from the error handler) must stay silent. Network failures
  // that some tests cause on purpose are not Angular errors and are ignored here.
  const close = page.close.bind(page);
  page.close = async (...args: Parameters<Page['close']>) => {
    await close(...args);
    const angular = consoleErrors.filter((message) => /\bNG0\d+|^ERROR\b|Unhandled/.test(message));
    if (angular.length > 0 || pageErrors.length > 0) {
      throw new Error(`Page reported errors:\n${[...angular, ...pageErrors].join('\n')}`);
    }
  };
  return { page, consoleErrors, pageErrors };
}

export async function openAdminHost(
  env: Environment,
  options: { query?: string; viewport?: { width: number; height: number }; page?: 'admin-host.html' | 'admin-host-csp.html' } = {},
): Promise<HostPage> {
  const page = await env.browser.newPage();
  await page.setViewport({ width: 1280, height: 1000, ...options.viewport });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${env.origin}/${options.page ?? 'admin-host.html'}${options.query ?? ''}`);
  await page.waitForFunction(
    () => (window as unknown as { testHostReady?: boolean }).testHostReady === true,
  );
  const close = page.close.bind(page);
  page.close = async (...args: Parameters<Page['close']>) => {
    await close(...args);
    const angular = consoleErrors.filter((message) => /\bNG0\d+|^ERROR\b|Unhandled/.test(message));
    if (angular.length > 0 || pageErrors.length > 0) {
      throw new Error(`Page reported errors:\n${[...angular, ...pageErrors].join('\n')}`);
    }
  };
  return { page, consoleErrors, pageErrors };
}

export const adminHost = {
  mount: (page: Page, id: string, props: Record<string, unknown> = {}, attributes: Record<string, string> = {}) =>
    page.evaluate((i, p, a) => (window as any).adminHost.mount(i, p, { attributes: a }), id, props as any, attributes),
  remove: (page: Page, id: string) => page.evaluate((i) => (window as any).adminHost.remove(i), id),
  set: (page: Page, id: string, prop: string, value: unknown) =>
    page.evaluate((i, p, v) => (window as any).adminHost.set(i, p, v), id, prop, value as any),
  events: <T = any>(page: Page, id: string, type?: string) =>
    page.evaluate((i, t) => (window as any).adminHost.events(i, t), id, type) as Promise<
      { type: string; detail: T; bubbles: boolean }[]
    >,
  view: (page: Page, id: string) => page.evaluate((i) => (window as any).adminHost.view(i), id) as Promise<string | null>,
  waitView: (page: Page, id: string, view: string, timeout = 20000) =>
    page.waitForFunction((i, v) => (window as any).adminHost.view(i) === v, { timeout }, id, view),
  ready: (page: Page, id: string, timeout = 20000) =>
    page.waitForFunction((i) => (window as any).adminHost.events(i, 'admin-ready').length > 0, { timeout }, id),
};

/** Wait until `selector` exists inside the element's shadow root. */
export const waitInside = (page: Page, id: string, selector: string, timeout = 20000) =>
  page.waitForFunction(
    (i, s) => !!document.getElementById(i)?.shadowRoot?.querySelector(s),
    { timeout },
    id,
    selector,
  );

/** Click the first element matching `selector` whose text contains `text`. */
export const clickText = (page: Page, id: string, selector: string, text: string) =>
  page.evaluate(
    (i, s, t) => {
      const el = [...document.getElementById(i)!.shadowRoot!.querySelectorAll(s)].find((e) =>
        (e.textContent ?? '').replace(/\s+/g, ' ').includes(t),
      ) as HTMLElement | undefined;
      if (!el) throw new Error(`no ${s} containing "${t}"`);
      el.click();
    },
    id,
    selector,
    text,
  );

// ---- helpers that talk to window.testHost in the page ----------------------------------------

type Props = Record<string, unknown>;

export const host = {
  mount: (
    page: Page,
    id: string,
    props: Props = {},
    opts: { attributes?: Record<string, string>; appendTo?: string; fallback?: string } = {},
  ) =>
    page.evaluate(
      (i, p, o) => (window as any).testHost.mount(i, p, o),
      id,
      props as any,
      opts as any,
    ),
  remove: (page: Page, id: string) => page.evaluate((i) => (window as any).testHost.remove(i), id),
  ack: (page: Page, id: string, result: unknown) =>
    page.evaluate((i, r) => (window as any).testHost.ack(i, r), id, result as any),
  set: (page: Page, id: string, prop: string, value: unknown) =>
    page.evaluate((i, p, v) => (window as any).testHost.set(i, p, v), id, prop, value as any),
  get: <T = unknown>(page: Page, id: string, prop: string) =>
    page.evaluate((i, p) => (window as any).testHost.get(i, p), id, prop) as Promise<T>,
  events: <T = any>(page: Page, id: string, type?: string) =>
    page.evaluate((i, t) => (window as any).testHost.events(i, t), id, type) as Promise<
      { type: string; detail: T; bubbles: boolean }[]
    >,
  pixels: (
    page: Page,
    id: string,
    which: 'artwork' | 'preview' | 'asset',
    points: [number, number][] = [],
  ) =>
    page.evaluate(
      (i, w, p) => (window as any).testHost.pixels(i, w, p),
      id,
      which,
      points,
    ) as Promise<{ width: number; height: number; pixels: number[][] }>,
  remountFromSave: (page: Page, id: string, newId: string, props: Props = {}) =>
    page.evaluate(
      (i, n, p) => (window as any).testHost.remountFromSave(i, n, p),
      id,
      newId,
      props as any,
    ),
  /** Every `zb:event` the page's document has seen (bubbled from any element), in order. */
  zbEvents: (page: Page) =>
    page.evaluate(() => (window as any).testHost.zb) as Promise<
      Array<{
        contract: number; extensionId: string; instanceId: string; slot: string; type: string;
        data: any; ts: number; targetId: string; bubbles: boolean; composed: boolean;
      }>
    >,
  /** Calls the element's `prepareForCart()`; never throws — resolves `{ ok, value | message }`. */
  prepare: (page: Page, id: string) =>
    page.evaluate((i) => (window as any).testHost.prepare(i), id) as Promise<
      { ok: true; value: Record<string, string> } | { ok: false; message: string; name: string }
    >,
  /** Dispatches a `zb:host-event` notification on the element. */
  hostEvent: (page: Page, id: string, type: string, data: unknown = {}) =>
    page.evaluate((i, t, d) => (window as any).testHost.hostEvent(i, t, d), id, type, data as any),
  waitStatus: (page: Page, id: string, status: string, timeout = 20000) =>
    page.waitForFunction(
      (i, s) => (window as any).testHost.status(i) === s,
      { timeout },
      id,
      status,
    ),
  waitSaveState: (page: Page, id: string, state: string, timeout = 20000) =>
    page.waitForFunction(
      (i, s) => (window as any).testHost.saveState(i) === s,
      { timeout },
      id,
      state,
    ),
};

/** ElementHandle inside the element's shadow root. */
export async function inside(
  page: Page,
  id: string,
  selector: string,
): Promise<ElementHandle<Element>> {
  const handle = await page.evaluateHandle(
    (i, s) => document.getElementById(i)!.shadowRoot!.querySelector(s),
    id,
    selector,
  );
  const element = handle.asElement();
  if (!element) throw new Error(`#${id}: nothing matches ${selector}`);
  return element as ElementHandle<Element>;
}

export const insideText = (page: Page, id: string, selector: string) =>
  page.evaluate(
    (i, s) =>
      document
        .getElementById(i)!
        .shadowRoot!.querySelector(s)
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? null,
    id,
    selector,
  );

export const insideCount = (page: Page, id: string, selector: string) =>
  page.evaluate(
    (i, s) => document.getElementById(i)!.shadowRoot!.querySelectorAll(s).length,
    id,
    selector,
  );

export const insideAll = (
  page: Page,
  id: string,
  selector: string,
  read: 'text' | 'disabled' = 'text',
) =>
  page.evaluate(
    (i, s, r) =>
      [...document.getElementById(i)!.shadowRoot!.querySelectorAll(s)].map((e) =>
        r === 'text'
          ? e.textContent!.replace(/\s+/g, ' ').trim()
          : (e as HTMLButtonElement).disabled,
      ),
    id,
    selector,
    read,
  );

export async function typeText(
  page: Page,
  id: string,
  selector: string,
  text: string,
): Promise<void> {
  const input = await inside(page, id, selector);
  await input.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  if (text) await input.type(text);
}

/** Click a label-wrapped radio / card by its visible text. */
export const clickCard = (page: Page, id: string, text: string) =>
  page.evaluate(
    (i, t) => {
      const card = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('label.card')].find(
        (l) => l.querySelector('.card-name')!.textContent!.trim() === t,
      ) as HTMLElement | undefined;
      if (!card) throw new Error(`no card "${t}"`);
      card.click();
    },
    id,
    text,
  );

export const clickButton = (page: Page, id: string, label: string) =>
  page.evaluate(
    (i, t) => {
      const button = [...document.getElementById(i)!.shadowRoot!.querySelectorAll('button')].find(
        (b) => b.textContent!.trim() === t || b.getAttribute('aria-label') === t,
      ) as HTMLButtonElement | undefined;
      if (!button) throw new Error(`no button "${label}"`);
      button.click();
    },
    id,
    label,
  );

export async function upload(page: Page, id: string, filePath: string): Promise<void> {
  const input = (await inside(page, id, 'input[type="file"]')) as ElementHandle<HTMLInputElement>;
  await input.uploadFile(filePath);
}

// ---- image fixtures ----------------------------------------------------------------------------

export type Rgba = [number, number, number, number];
export const RED: Rgba = [220, 30, 30, 255];
export const GREEN: Rgba = [30, 180, 60, 255];
export const BLUE: Rgba = [30, 60, 220, 255];
export const YELLOW: Rgba = [240, 220, 20, 255];

const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
  return out;
};
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d.set([8, 6, 0, 0, 0], 8);
  return chunk('IHDR', d);
};

/** Opaque PNG whose four quadrants are [top-left, top-right, bottom-left, bottom-right]. */
export function quadrantPng(
  w: number,
  h: number,
  colors: [Rgba, Rgba, Rgba, Rgba] = [RED, GREEN, BLUE, YELLOW],
): Buffer {
  const row = (y: number) => {
    const line = Buffer.alloc(1 + w * 4); // filter byte 0 + RGBA
    for (let x = 0; x < w; x++)
      line.set(colors[(y >= h / 2 ? 2 : 0) + (x >= w / 2 ? 1 : 0)], 1 + x * 4);
    return line;
  };
  const top = row(0);
  const bottom = row(h - 1);
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => (y < h / 2 ? top : bottom)));
  return Buffer.concat([
    SIGNATURE,
    ihdr(w, h),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG with an animation control chunk (APNG). */
export function animatedPng(): Buffer {
  const base = quadrantPng(40, 40);
  const split = SIGNATURE.length + 25; // after IHDR (4 + 4 + 13 + 4)
  const actl = chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]));
  return Buffer.concat([base.subarray(0, split), actl, base.subarray(split)]);
}

/** Valid signature + header, then garbage: passes the byte sniff, fails to decode. */
export function corruptPng(): Buffer {
  return Buffer.concat([
    SIGNATURE,
    ihdr(400, 400),
    chunk('IDAT', Buffer.from('this is not deflate data')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Header claims far more than 25 megapixels. */
export function hugePng(): Buffer {
  return Buffer.concat([
    SIGNATURE,
    ihdr(8000, 8000),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0, 0, 0, 0, 1])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Insert an EXIF APP1 segment with the given orientation right after the JPEG SOI marker. */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0,
    0x2a,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]),
    payload,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/** Make a real JPEG of quadrant colours using the browser's own encoder. */
export async function quadrantJpeg(page: Page, w: number, h: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    async (width, height, colors) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      colors.forEach((c, i) => {
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(
          (i % 2) * (width / 2),
          Math.floor(i / 2) * (height / 2),
          width / 2,
          height / 2,
        );
      });
      const blob: Blob = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    },
    w,
    h,
    [RED, GREEN, BLUE, YELLOW],
  );
  return Buffer.from(base64, 'base64');
}

export function writeFixture(env: Environment, name: string, bytes: Buffer): string {
  const file = join(env.tmp, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

/** True when `actual` is within `tolerance` per channel of `expected`. */
export const near = (actual: number[], expected: number[], tolerance = 6) =>
  expected.every((v, i) => Math.abs(actual[i] - v) <= tolerance);

export const ASSET_PATHS = {
  samplePhoto: join(root, 'public', 'assets', 'samples', 'photo-landscape.jpg'),
  portraitPhoto: join(root, 'public', 'assets', 'samples', 'photo-portrait.jpg'),
  /** A real, valid WOFF2 file (one of the bundled default fonts) reused as a custom-upload fixture. */
  fontSample: join(root, 'public', 'assets', 'fonts', 'mono-bold.woff2'),
};
