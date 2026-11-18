#!/usr/bin/env node
/**
 * Local-development stand-in for ZenBasket's signer.
 *
 * The Worker has NO development shortcut: no static token, no bypass flag, no fallback secret. Locally you
 * therefore authenticate the way ZenBasket does, with real signatures made from your local plugin secret:
 *
 *   npm run dev:token -- --store 766                       # prints a merchant JWT
 *   npm run dev:event -- --store 766 --customization <uuid> --product <id>   # POSTs a signed order.confirmed
 *
 * Configuration comes from the environment, else from `.dev.vars` in the current directory (the same file
 * `wrangler dev` reads): ZB_PLUGIN_SECRET (>= 32 chars) and ZB_PLUGIN_ID. The secret is never printed.
 *
 * `event --occurred-at <iso>` pins the timestamp so a retry is byte-identical (a replay, not a 409).
 *
 * It uses only node:crypto and implements the contract in docs/zenbasket-integration.md §3-§4 line for line,
 * independently of the Worker's own code, so it doubles as a check that the documented scheme interoperates.
 */

import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_SECRET_LENGTH = 32;
export const WEBHOOK_KEY_INFO = 'zb-plugin:v1:order-webhook';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Merchant token: HS256, signed with the plugin secret itself. Claims: storeId, pluginId, iat, exp (+ sub).
 * @param {{ secret: string, pluginId: string | number, storeId: string | number, ttlSeconds?: number, sub?: string, now?: number }} options
 * @returns {string}
 */
export function signMerchantJwt({ secret, pluginId, storeId, ttlSeconds = 3600, sub, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const claims = { storeId: asId(storeId), pluginId: asId(pluginId), iat, exp: iat + ttlSeconds, ...(sub ? { sub } : {}) };
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(claims);
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

/** The order-webhook key: HKDF-SHA256(secret, salt "", info "zb-plugin:v1:order-webhook", 32 bytes). */
export function deriveWebhookKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), WEBHOOK_KEY_INFO, 32));
}

/**
 * Headers for an order callback: HMAC-SHA256 over `<timestamp>.<exact body>`, `v1=<hex>`.
 * @param {{ secret: string, body: string, now?: number }} options
 * @returns {Record<string, string>}
 */
export function signWebhook({ secret, body, now = Date.now() }) {
  const timestamp = Math.floor(now / 1000);
  const signature = 'v1=' + createHmac('sha256', deriveWebhookKey(secret)).update(`${timestamp}.${body}`).digest('hex');
  return { 'Content-Type': 'application/json', 'X-ZB-Timestamp': String(timestamp), 'X-ZB-Signature': signature };
}

/**
 * A contract-v1 `order.confirmed` envelope with one personalized line. Pass the same `eventId` AND the same
 * `occurredAt` to resend byte-identical bytes (a true retry); a different payload under one eventId is a 409.
 * @param {{ storeId: string | number, customizationId: string, productId: string, eventId?: string, orderId?: string, lineId?: string, variantId?: string, occurredAt?: string }} input
 * @returns {string} the exact JSON text to sign and send
 */
export function buildOrderConfirmedEvent(input) {
  return JSON.stringify({
    contract: 1,
    eventId: input.eventId ?? `dev-${randomUUID()}`,
    type: 'order.confirmed',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    storeId: String(input.storeId),
    order: { id: input.orderId ?? 'DEV-ORDER-1' },
    lines: [{
      id: input.lineId ?? 'DEV-LINE-1',
      productId: String(input.productId),
      ...(input.variantId ? { variantId: String(input.variantId) } : {}),
      quantity: 1,
      extensions: { customizationId: String(input.customizationId) },
    }],
  });
}

/** A ZenBasket id is a positive integer; keep numeric ids numeric (as the real issuer signs them). */
function asId(value) {
  const text = String(value);
  return /^[1-9]\d{0,14}$/.test(text) ? Number(text) : text;
}

/**
 * KEY=VALUE lines of a dotenv-style file (comments and blank lines ignored, surrounding quotes stripped).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDevVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function loadSettings(env = process.env) {
  const file = existsSync('.dev.vars') ? parseDevVars(readFileSync('.dev.vars', 'utf8')) : {};
  const pick = (name) => (env[name] ?? file[name] ?? '').trim();
  return { secret: pick('ZB_PLUGIN_SECRET'), pluginId: pick('ZB_PLUGIN_ID') };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(argv[i]);
  }
  return args;
}

function fail(message) {
  console.error(`zb-dev-sign: ${message}`);
  process.exit(1);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const settings = loadSettings();
  if (settings.secret.length < MIN_SECRET_LENGTH) {
    fail(`ZB_PLUGIN_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters (set it in .dev.vars or the environment; the Worker would refuse it too).`);
  }

  if (command === 'jwt') {
    const store = args.store ?? fail('--store <storeId> is required');
    const pluginId = String(args.plugin ?? settings.pluginId);
    if (!pluginId) fail('--plugin <id> or ZB_PLUGIN_ID is required');
    process.stdout.write(
      signMerchantJwt({
        secret: settings.secret, pluginId, storeId: store,
        ttlSeconds: args.ttl ? Number(args.ttl) : 3600, sub: args.sub === true ? undefined : args.sub,
      }) + '\n',
    );
    return;
  }

  if (command === 'event') {
    let body;
    if (args.file) {
      body = readFileSync(String(args.file), 'utf8');
    } else {
      const store = args.store ?? fail('--store <storeId> is required (or pass --file <event.json>)');
      const customization = args.customization ?? fail('--customization <uuid> is required');
      const product = args.product ?? fail('--product <productId> is required');
      body = buildOrderConfirmedEvent({
        storeId: store,
        customizationId: String(customization),
        productId: String(product),
        eventId: args['event-id'] ? String(args['event-id']) : undefined,
        orderId: args.order ? String(args.order) : undefined,
        lineId: args.line ? String(args.line) : undefined,
        variantId: args.variant ? String(args.variant) : undefined,
        occurredAt: args['occurred-at'] ? String(args['occurred-at']) : undefined,
      });
    }
    const headers = signWebhook({ secret: settings.secret, body });
    const url = `${String(args.url ?? 'http://localhost:8787').replace(/\/+$/, '')}/api/v1/integrations/personalization/events`;
    if (args['dry-run']) {
      console.log(JSON.stringify({ url, headers, body: JSON.parse(body) }, null, 2));
      return;
    }
    const res = await fetch(url, { method: 'POST', headers, body });
    console.log(`HTTP ${res.status}`);
    console.log(await res.text());
    process.exitCode = res.ok ? 0 : 1;
    return;
  }

  fail('usage: zb-dev-sign.mjs jwt --store <id> [--plugin <id>] [--ttl <s>] [--sub <user>]\n' +
       '       zb-dev-sign.mjs event --store <id> --customization <uuid> --product <id> [--order <id>] [--line <id>]\n' +
       '                        [--variant <id>] [--event-id <id>] [--occurred-at <iso>] [--url <worker base url>]\n' +
       '                        [--file <event.json>] [--dry-run]\n' +
       '       (resend with the SAME --event-id and --occurred-at to retry; a different payload under one event id is a 409)');
}

/** True only when this file is the entry script (also when started through a symlink), not when imported. */
function isEntryScript() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  await main(process.argv.slice(2));
}
