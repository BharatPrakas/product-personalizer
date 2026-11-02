/**
 * Encryption at rest for integration secrets (AES-256-GCM) and generation of new secrets.
 *
 * Storage format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The (store id, credential id)
 * pair is bound as AEAD associated data, so a ciphertext copied onto another credential row or store
 * fails authentication instead of silently decrypting. The master key comes from a Worker secret and
 * is never stored in the database.
 *
 * Uses `node:crypto` (available on Workers with `nodejs_compat`), like the asset-URL signer.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialCryptoError extends Error {}

/** Parse a base64 / base64url 32-byte master key. Throws a message that never contains the key. */
export function parseMasterKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(`INTEGRATION_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes.`);
  }
  return key;
}

function aad(storeId: string, credentialId: string): Buffer {
  return Buffer.from(`integration-credential:v1:${storeId}:${credentialId}`);
}

export function encryptSecret(masterKey: Buffer, storeId: string, credentialId: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(aad(storeId, credentialId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(masterKey: Buffer, storeId: string, credentialId: string, stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new CredentialCryptoError('Unsupported secret format.');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CredentialCryptoError('Malformed secret.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAAD(aad(storeId, credentialId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialCryptoError('The stored secret could not be decrypted.');
  }
}

/** A fresh 256-bit integration secret, shown to its owner exactly once. */
export function generateSecret(): string {
  return `zbsec_${randomBytes(32).toString('base64url')}`;
}
