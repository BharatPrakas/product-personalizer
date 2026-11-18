/**
 * `scripts/zb-dev-sign.mjs` is how a developer authenticates locally now that the Worker has no dev token and
 * no bypass. It must produce REAL credentials the Worker accepts (it is an independent implementation of the
 * documented contract, using only node:crypto), and it must never print the secret.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  INTEGRATIONS,
  OTHER_PLUGIN_SECRET,
  PRODUCT_ID,
  STORE_A,
  TEST_PLUGIN_ID,
  TEST_PLUGIN_SECRET,
  applyMigrations,
  call,
  json,
  queryDb,
  resetBucket,
  saveCustomization,
  seedPersonalizableProduct,
  truncateAll,
} from './helpers';
import { buildOrderConfirmedEvent, parseDevVars, signMerchantJwt, signWebhook } from '../scripts/zb-dev-sign.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'zb-dev-sign.mjs');

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetBucket();
});

/** Runs the CLI from an empty directory (so no real `.dev.vars` can leak in) with exactly this environment. */
function runCli(args: string[], env: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'zb-dev-sign-'));
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
}

describe('zb-dev-sign: merchant tokens', () => {
  it('signs a token with { storeId, pluginId, iat, exp } that the Worker accepts', async () => {
    const token = signMerchantJwt({ secret: TEST_PLUGIN_SECRET, pluginId: TEST_PLUGIN_ID, storeId: '766' });
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    // Numeric ids stay numeric, as ZenBasket signs them.
    expect(claims).toMatchObject({ storeId: 766, pluginId: 160 });
    expect(claims.exp - claims.iat).toBe(3600);
    const res = await call(`${ADMIN}/configs`, { token });
    expect(res.status).toBe(200);
  });

  it('is refused when signed with another secret or for another plugin', async () => {
    expect((await call(`${ADMIN}/configs`, { token: signMerchantJwt({ secret: OTHER_PLUGIN_SECRET, pluginId: TEST_PLUGIN_ID, storeId: '766' }) })).status).toBe(401);
    expect((await call(`${ADMIN}/configs`, { token: signMerchantJwt({ secret: TEST_PLUGIN_SECRET, pluginId: '999', storeId: '766' }) })).status).toBe(401);
  });

  it('keeps a non-numeric store id as a string', () => {
    const token = signMerchantJwt({ secret: TEST_PLUGIN_SECRET, pluginId: '160', storeId: 'store_alpha', sub: 'dev@example.test' });
    expect(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())).toMatchObject({ storeId: 'store_alpha', sub: 'dev@example.test' });
  });
});

describe('zb-dev-sign: order callbacks', () => {
  it('signs a callback the Worker accepts and links the customization', async () => {
    await seedPersonalizableProduct();
    const { customizationId } = await saveCustomization();
    const body = JSON.stringify({
      contract: 1, eventId: 'evt-dev-1', type: 'order.confirmed', occurredAt: new Date().toISOString(), storeId: STORE_A,
      order: { id: 'ORD-DEV' },
      lines: [{ id: 'L1', productId: PRODUCT_ID, quantity: 1, extensions: { customizationId } }],
    });
    const res = await call(`${INTEGRATIONS}/events`, {
      method: 'POST', token: null, rawBody: new TextEncoder().encode(body),
      headers: signWebhook({ secret: TEST_PLUGIN_SECRET, body }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).results).toEqual([expect.objectContaining({ status: 'applied', customizationId })]);
    expect(await queryDb(`SELECT status FROM customizations WHERE id = $1`, [customizationId])).toEqual([{ status: 'ordered' }]);
  });

  it('a retry with the same eventId and occurredAt is a true replay (duplicate:true), not a 409', async () => {
    await seedPersonalizableProduct();
    const { customizationId } = await saveCustomization();
    const input = { storeId: STORE_A, customizationId, productId: PRODUCT_ID, eventId: 'evt-retry-1', occurredAt: '2026-11-18T10:00:00.000Z' };
    const send = async (body: string) =>
      call(`${INTEGRATIONS}/events`, {
        method: 'POST', token: null, rawBody: new TextEncoder().encode(body),
        headers: signWebhook({ secret: TEST_PLUGIN_SECRET, body }),
      });
    expect(buildOrderConfirmedEvent(input)).toBe(buildOrderConfirmedEvent(input));
    const first = await json(await send(buildOrderConfirmedEvent(input)));
    expect(first).toMatchObject({ duplicate: false, results: [{ status: 'applied' }] });
    const retry = await json(await send(buildOrderConfirmedEvent(input)));
    expect(retry).toMatchObject({ duplicate: true, results: first.results });
    // Without pinning the time the payload differs, and the Worker (correctly) refuses to treat it as a retry.
    const unpinned = await send(buildOrderConfirmedEvent({ ...input, occurredAt: '2026-11-18T10:00:01.000Z' }));
    expect(unpinned.status).toBe(409);
  });

  it('is refused when signed with another secret', async () => {
    await seedPersonalizableProduct();
    const body = '{"contract":1}';
    const res = await call(`${INTEGRATIONS}/events`, {
      method: 'POST', token: null, rawBody: new TextEncoder().encode(body),
      headers: signWebhook({ secret: OTHER_PLUGIN_SECRET, body }),
    });
    expect(res.status).toBe(401);
  });
});

describe('zb-dev-sign: command line', () => {
  const env = { ZB_PLUGIN_SECRET: TEST_PLUGIN_SECRET, ZB_PLUGIN_ID: TEST_PLUGIN_ID };

  it('prints a token the Worker accepts, and never prints the secret', async () => {
    const run = runCli(['jwt', '--store', '766'], env);
    expect(run.status).toBe(0);
    expect(run.stdout + run.stderr).not.toContain(TEST_PLUGIN_SECRET);
    const token = run.stdout.trim();
    expect(token.split('.')).toHaveLength(3);
    expect((await call(`${ADMIN}/configs`, { token })).status).toBe(200);
  });

  it('prints a signed callback (dry run) without the secret', () => {
    const run = runCli(['event', '--store', '766', '--customization', crypto.randomUUID(), '--product', 'p-1', '--dry-run'], env);
    expect(run.status).toBe(0);
    expect(run.stdout + run.stderr).not.toContain(TEST_PLUGIN_SECRET);
    const printed = JSON.parse(run.stdout);
    expect(printed.url).toBe('http://localhost:8787/api/v1/integrations/personalization/events');
    expect(printed.headers['X-ZB-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(printed.body).toMatchObject({ contract: 1, type: 'order.confirmed', storeId: '766' });
  });

  it.each([
    ['missing', {}],
    ['too short', { ZB_PLUGIN_SECRET: 'too-short' }],
  ])('fails closed, naming the variable but never a value, when the secret is %s', (_label, vars) => {
    const run = runCli(['jwt', '--store', '766'], { ZB_PLUGIN_ID: TEST_PLUGIN_ID, ...vars });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/ZB_PLUGIN_SECRET/);
    expect(run.stderr).not.toContain('too-short');
  });

  it('reads ZB_PLUGIN_SECRET / ZB_PLUGIN_ID from .dev.vars like wrangler does, with the environment taking precedence', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'zb-dev-sign-'));
    writeFileSync(join(cwd, '.dev.vars'), `# local\nZB_PLUGIN_SECRET="${OTHER_PLUGIN_SECRET}"\nZB_PLUGIN_ID=160\n`);
    const fromFile = execFileSync(process.execPath, [SCRIPT, 'jwt', '--store', '1'], { cwd, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' }).trim();
    const fromEnv = execFileSync(process.execPath, [SCRIPT, 'jwt', '--store', '1'], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' }).trim();
    const sigOf = (t: string) => t.split('.')[2];
    expect(sigOf(fromFile)).not.toBe(sigOf(fromEnv)); // different secrets => different signatures
  });

  it('still runs when started through a symlink (and does nothing when merely imported)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zb-dev-sign-'));
    const link = join(dir, 'sign.mjs');
    symlinkSync(SCRIPT, link);
    const run = spawnSync(process.execPath, [link, 'jwt', '--store', '1'], { cwd: dir, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split('.')).toHaveLength(3);
  });

  it('parses dotenv-style files', () => {
    expect(parseDevVars('# c\nA=1\n  B = "two words" \nexport C=\'3\'\nnot a line\n#D=4\n')).toEqual({ A: '1', B: 'two words', C: '3' });
  });
});
