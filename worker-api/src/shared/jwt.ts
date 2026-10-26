/**
 * Minimal HS256 JWT verification using Web Crypto (available on both the Workers runtime and Node).
 *
 * The Worker only VERIFIES tokens; it never mints them. The hosting platform (ZenBasket) signs a
 * short-lived session token with a shared secret and includes the store/tenant as a claim. The
 * store identity is therefore taken from the verified signature, not from any client-supplied field.
 */

export interface JwtClaims {
  /** Subject (user id), optional. */
  sub?: string;
  /** Tenant/store id. Accepts `store_id` or `storeId`. */
  store_id?: string;
  storeId?: string;
  /** Space- or array-delimited scopes. */
  scope?: string;
  scopes?: string[];
  exp?: number;
  nbf?: number;
  iat?: number;
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

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = base64UrlToBytes(signatureB64);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  // Web Crypto's verify is constant-time and the correct usage for an imported ['verify'] key.
  const valid = await crypto.subtle.verify('HMAC', key, signature, data);
  if (!valid) return { ok: false, reason: 'bad signature' };

  let claims: JwtClaims;
  try {
    claims = JSON.parse(bytesToString(base64UrlToBytes(payloadB64)));
  } catch {
    return { ok: false, reason: 'unreadable payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && now > claims.exp + LEEWAY_SECONDS) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof claims.nbf === 'number' && now + LEEWAY_SECONDS < claims.nbf) {
    return { ok: false, reason: 'token not yet valid' };
  }
  return { ok: true, claims };
}

export function scopesFromClaims(claims: JwtClaims): string[] {
  if (Array.isArray(claims.scopes)) return claims.scopes.filter((s): s is string => typeof s === 'string');
  if (typeof claims.scope === 'string') return claims.scope.split(/\s+/).filter(Boolean);
  return [];
}
