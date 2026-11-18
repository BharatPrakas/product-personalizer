import { describe, expect, it } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import {
  MIN_PLUGIN_SECRET_LENGTH,
  WEBHOOK_KEY_INFO,
  deriveWebhookKey,
  normalizePluginSecret,
} from '../src/modules/zenbasket-auth/plugin-secret';
import { checkTimestamp, signBody, signatureMatches } from '../src/modules/zenbasket-auth/webhook-signature';
import { customizationKeyPrefix, assetKeyPrefix, generateCustomizationObjectKey } from '../src/storage/object-storage';
import { OTHER_PLUGIN_SECRET, TEST_PLUGIN_SECRET } from './helpers';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('plugin secret handling', () => {
  it('trims a configured secret and refuses one that is missing, blank or too short to be ZenBasket’s', () => {
    expect(normalizePluginSecret(`  ${TEST_PLUGIN_SECRET}\n`)).toBe(TEST_PLUGIN_SECRET);
    expect(normalizePluginSecret(undefined)).toBeNull();
    expect(normalizePluginSecret('')).toBeNull();
    expect(normalizePluginSecret('   ')).toBeNull();
    expect(normalizePluginSecret('x'.repeat(MIN_PLUGIN_SECRET_LENGTH - 1))).toBeNull();
    expect(normalizePluginSecret('x'.repeat(MIN_PLUGIN_SECRET_LENGTH))).not.toBeNull();
  });
});

describe('order-webhook key derivation (HKDF-SHA256)', () => {
  it('matches an independent implementation (Node hkdfSync, what the ZenBasket signer uses)', async () => {
    const expected = Buffer.from(hkdfSync('sha256', Buffer.from(TEST_PLUGIN_SECRET, 'utf8'), Buffer.alloc(0), WEBHOOK_KEY_INFO, 32));
    expect(hex(await deriveWebhookKey(TEST_PLUGIN_SECRET))).toBe(expected.toString('hex'));
  });

  it('is pinned by a known answer, so the info string can never change silently (breaking the sender)', async () => {
    expect(WEBHOOK_KEY_INFO).toBe('zb-plugin:v1:order-webhook');
    expect(hex(await deriveWebhookKey(TEST_PLUGIN_SECRET))).toBe(
      '67bf6aafeb509fdb25be8538101e719bead8c81927071a53635edde67dacbec9',
    );
  });

  it('is deterministic, 32 bytes, separated by secret, and is not the root secret itself', async () => {
    const a = await deriveWebhookKey(TEST_PLUGIN_SECRET);
    expect(a).toHaveLength(32);
    expect(hex(await deriveWebhookKey(TEST_PLUGIN_SECRET))).toBe(hex(a));
    expect(hex(await deriveWebhookKey(OTHER_PLUGIN_SECRET))).not.toBe(hex(a));
    expect(hex(a)).not.toBe(Buffer.from(TEST_PLUGIN_SECRET).toString('hex'));
  });
});

describe('request signing', () => {
  const key = Buffer.alloc(32, 7);
  const other = Buffer.alloc(32, 8);

  it('signs "<timestamp>.<raw body>" with HMAC-SHA256 (v1=<hex>)', () => {
    const expected = `v1=${createHmac('sha256', key).update('1700000000.{"a":1}').digest('hex')}`;
    expect(signBody(key, 1700000000, '{"a":1}')).toBe(expected);
  });

  it('matches only the exact body, timestamp and key', () => {
    const sig = signBody(key, 1700000000, '{"a":1}');
    expect(signatureMatches(key, '1700000000', '{"a":1}', sig)).toBe(true);
    expect(signatureMatches(key, '1700000000', '{"a":2}', sig)).toBe(false);
    expect(signatureMatches(key, '1700000001', '{"a":1}', sig)).toBe(false);
    expect(signatureMatches(other, '1700000000', '{"a":1}', sig)).toBe(false);
    expect(signatureMatches(key, '1700000000', '{"a":1}', 'v1=short')).toBe(false);
    expect(signatureMatches(key, '1700000000', '{"a":1}', '')).toBe(false);
  });

  it('accepts timestamps only inside the window', () => {
    const now = 1_700_000_000_000;
    expect(checkTimestamp('1700000000', now, 300).ok).toBe(true);
    expect(checkTimestamp('1699999800', now, 300).ok).toBe(true);
    expect(checkTimestamp('1699999699', now, 300).ok).toBe(false);
    expect(checkTimestamp('1700000301', now, 300).ok).toBe(false);
    expect(checkTimestamp('abc', now, 300).ok).toBe(false);
    expect(checkTimestamp('1700000000.5', now, 300).ok).toBe(false);
    expect(checkTimestamp(undefined, now, 300).ok).toBe(false);
  });
});

describe('customer object keys', () => {
  it('live in a private prefix that is a sibling of — never under — the public assets prefix', () => {
    const priv = customizationKeyPrefix('store_a');
    const pub = assetKeyPrefix('store_a');
    expect(priv).toBe('stores/store_a/product-personalization/customizations/');
    expect(priv.startsWith(pub)).toBe(false);
    expect(pub.startsWith(priv)).toBe(false);
    const k = generateCustomizationObjectKey({ storeId: 'store_a', type: 'image/png' });
    expect(k.startsWith(priv)).toBe(true);
    expect(k.endsWith('.png')).toBe(true);
  });
});
