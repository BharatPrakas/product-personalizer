import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CredentialCryptoError,
  decryptSecret,
  encryptSecret,
  generateSecret,
  parseMasterKey,
} from '../src/modules/integration-credentials/crypto';
import { checkTimestamp, signBody, signatureMatches } from '../src/modules/integration-credentials/signature';
import { issueCustomerToken, verifyCustomerToken } from '../src/modules/personalization/customer-token';
import { customizationKeyPrefix, assetKeyPrefix, generateCustomizationObjectKey } from '../src/storage/object-storage';
import { TEST_ENCRYPTION_KEY } from './helpers';

const key = parseMasterKey(TEST_ENCRYPTION_KEY);

describe('integration secret encryption', () => {
  it('round-trips and never stores the plaintext', () => {
    const secret = generateSecret();
    const stored = encryptSecret(key, 'store_a', 'cred-1', secret);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(key, 'store_a', 'cred-1', stored)).toBe(secret);
  });

  it('uses a fresh IV per encryption', () => {
    expect(encryptSecret(key, 's', 'c', 'x')).not.toBe(encryptSecret(key, 's', 'c', 'x'));
  });

  it('refuses a ciphertext moved to another store or credential (AAD binding)', () => {
    const stored = encryptSecret(key, 'store_a', 'cred-1', 'secret');
    expect(() => decryptSecret(key, 'store_b', 'cred-1', stored)).toThrow(CredentialCryptoError);
    expect(() => decryptSecret(key, 'store_a', 'cred-2', stored)).toThrow(CredentialCryptoError);
  });

  it('refuses the wrong master key and tampered data', () => {
    const stored = encryptSecret(key, 's', 'c', 'secret');
    expect(() => decryptSecret(Buffer.alloc(32, 9), 's', 'c', stored)).toThrow(CredentialCryptoError);
    const parts = stored.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(key, 's', 'c', parts.join('.'))).toThrow(CredentialCryptoError);
    expect(() => decryptSecret(key, 's', 'c', 'garbage')).toThrow(CredentialCryptoError);
  });

  it('rejects a master key of the wrong length without echoing it', () => {
    expect(() => parseMasterKey('c2hvcnQ=')).toThrow(/32 bytes/);
    try {
      parseMasterKey('c2hvcnQ=');
    } catch (error) {
      expect(String(error)).not.toContain('c2hvcnQ=');
    }
  });
});

describe('request signing', () => {
  it('signs "<timestamp>.<raw body>" with HMAC-SHA256 (v1=<hex>)', () => {
    const expected = `v1=${createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex')}`;
    expect(signBody('s3cret', 1700000000, '{"a":1}')).toBe(expected);
  });

  it('matches only the exact body, timestamp and secret', () => {
    const sig = signBody('s3cret', 1700000000, '{"a":1}');
    expect(signatureMatches('s3cret', '1700000000', '{"a":1}', sig)).toBe(true);
    expect(signatureMatches('s3cret', '1700000000', '{"a":2}', sig)).toBe(false);
    expect(signatureMatches('s3cret', '1700000001', '{"a":1}', sig)).toBe(false);
    expect(signatureMatches('other', '1700000000', '{"a":1}', sig)).toBe(false);
    expect(signatureMatches('s3cret', '1700000000', '{"a":1}', 'v1=short')).toBe(false);
    expect(signatureMatches('s3cret', '1700000000', '{"a":1}', '')).toBe(false);
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

describe('customer tokens', () => {
  const secret = 'token-secret';
  const now = new Date('2026-01-01T00:00:00Z');
  const claims = { scope: 'customization' as const, storeId: 'store_a', subject: 'AAAAAAAA-0000-4000-8000-000000000001' };

  it('verifies for the exact scope, store and subject (case-insensitive id)', () => {
    const { token } = issueCustomerToken(secret, claims, 60, now);
    expect(verifyCustomerToken(secret, token, { ...claims, subject: claims.subject.toLowerCase() }, now)).toBe('ok');
  });

  it('rejects another subject, store or scope', () => {
    const { token } = issueCustomerToken(secret, claims, 60, now);
    expect(verifyCustomerToken(secret, token, { ...claims, subject: 'bbbbbbbb-0000-4000-8000-000000000001' }, now)).toBe('wrong_subject');
    expect(verifyCustomerToken(secret, token, { ...claims, storeId: 'store_b' }, now)).toBe('wrong_subject');
    expect(verifyCustomerToken(secret, token, { ...claims, scope: 'upload' }, now)).toBe('wrong_subject');
  });

  it('expires', () => {
    const { token, expiresAt } = issueCustomerToken(secret, claims, 60, now);
    expect(verifyCustomerToken(secret, token, claims, new Date(expiresAt.getTime() - 1000))).toBe('ok');
    expect(verifyCustomerToken(secret, token, claims, expiresAt)).toBe('expired');
  });

  it('rejects forged, re-signed and malformed tokens', () => {
    const { token } = issueCustomerToken(secret, claims, 60, now);
    expect(verifyCustomerToken('other-secret', token, claims, now)).toBe('bad_signature');
    const [prefix, body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), exp: 9999999999 })).toString('base64url');
    expect(verifyCustomerToken(secret, `${prefix}.${forged}.${sig}`, claims, now)).toBe('bad_signature');
    expect(verifyCustomerToken(secret, 'nope', claims, now)).toBe('malformed');
    expect(verifyCustomerToken(secret, '', claims, now)).toBe('malformed');
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
