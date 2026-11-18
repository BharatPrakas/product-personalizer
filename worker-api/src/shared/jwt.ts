/**
 * Minimal HS256 JWT verification using Web Crypto (available on both the Workers runtime and Node).
 *
 * The Worker only VERIFIES tokens; it never mints them. The hosting platform (ZenBasket) signs a
 * short-lived session token with the plugin-level secret and includes the store/tenant as a claim. The
 * store identity is therefore taken from the verified signature, not from any client-supplied field.
 * Which plugin the token is for (`pluginId`) and which store (`storeId`) are checked by the
 * authentication middleware.
 */

/** The claims of a ZenBasket merchant token: `{ storeId, pluginId, iat, exp }` (+ optional `sub`, `nbf`). */
export interface JwtClaims {
  /** Subject (user id), optional. Recorded as the audit actor. */
  sub?: string;
  /** The store (tenant): a positive integer (ZenBasket) or a non-empty string. */
  storeId?: string | number;
  /** The ZenBasket plugin the token was issued for (a positive integer, or the same id as a string). */
  pluginId?: string | number;
  iat?: number;
  exp?: number;
  nbf?: number;
  [claim: string]: unknown;
}

export type VerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: string };

const LEEWAY_SECONDS = 30;

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Verifies an HS256 token against `secret`. `alg` must be exactly HS256, and `iat` and `exp` are REQUIRED:
 * a token with no expiry would be a permanent bearer credential, which the short-lived session contract
 * does not allow.
 */
export async function verifyJwtHs256(token: string, secret: string): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(bytesToString(base64UrlToBytes(headerB64)));
  } catch {
    return { ok: false, reason: 'unreadable header' };
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'unsupported algorithm' };

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(signatureB64);
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  // Web Crypto's verify is constant-time and the correct usage for an imported ['verify'] key.
  const valid = await crypto.subtle.verify('HMAC', hmacKey, signature, data);
  if (!valid) return { ok: false, reason: 'bad signature' };

  let claims: JwtClaims;
  try {
    claims = JSON.parse(bytesToString(base64UrlToBytes(payloadB64)));
  } catch {
    return { ok: false, reason: 'unreadable payload' };
  }

  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    return { ok: false, reason: 'unreadable payload' };
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
    return { ok: false, reason: 'token has no issue time' };
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: 'token has no expiry' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (now > claims.exp + LEEWAY_SECONDS) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof claims.nbf === 'number' && now + LEEWAY_SECONDS < claims.nbf) {
    return { ok: false, reason: 'token not yet valid' };
  }
  return { ok: true, claims };
}
