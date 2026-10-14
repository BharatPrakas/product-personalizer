/**
 * RFC 4122 version 4 UUID. `crypto.randomUUID()` only exists in secure contexts (HTTPS / localhost),
 * and the element must also work on plain-HTTP host pages, so fall back to `getRandomValues`
 * (available everywhere) and finally to Math.random.
 */
export function uuid(cryptoSource: Partial<Crypto> | undefined = globalThis.crypto): string {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoSource?.getRandomValues === 'function') {
    cryptoSource.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
