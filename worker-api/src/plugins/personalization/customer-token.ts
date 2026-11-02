/**
 * Scoped, expiring tokens for the anonymous shopper.
 *
 * A `customizationId` is an identifier, not a credential: it travels through the cart, the order
 * payload and ZenBasket's database, so it is never enough to read or change anything. The shopper's
 * browser instead holds one of two HMAC-signed tokens issued when it saves:
 *
 *   scope `customization`  subject = customization id   read / update THAT customization only
 *   scope `upload`         subject = customer asset id  lets THAT upload be attached once
 *
 * Both are bound to one store and expire. Format: `zbc1.<base64url payload>.<base64url HMAC>`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type CustomerTokenScope = 'customization' | 'upload';

interface Payload {
  v: 1;
  scope: CustomerTokenScope;
  sid: string;
  sub: string;
  exp: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

function mac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`customer-token:v1.${body}`).digest('base64url');
}

export function issueCustomerToken(
  secret: string,
  claims: { scope: CustomerTokenScope; storeId: string; subject: string },
  ttlSeconds: number,
  now: Date,
): IssuedToken {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const payload: Payload = { v: 1, scope: claims.scope, sid: claims.storeId, sub: claims.subject.toLowerCase(), exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `zbc1.${body}.${mac(secret, body)}`, expiresAt: new Date(exp * 1000) };
}

export type TokenVerdict = 'ok' | 'malformed' | 'bad_signature' | 'expired' | 'wrong_subject';

/** Verifies signature, expiry, scope, store and subject; the verdict never reveals more than that. */
export function verifyCustomerToken(
  secret: string,
  token: string,
  expected: { scope: CustomerTokenScope; storeId: string; subject: string },
  now: Date,
): TokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'zbc1') return 'malformed';
  const expectedMac = Buffer.from(mac(secret, parts[1]));
  const given = Buffer.from(parts[2]);
  if (given.length !== expectedMac.length || !timingSafeEqual(given, expectedMac)) return 'bad_signature';
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Payload;
  } catch {
    return 'malformed';
  }
  if (payload.v !== 1 || typeof payload.exp !== 'number') return 'malformed';
  if (payload.exp * 1000 <= now.getTime()) return 'expired';
  if (payload.scope !== expected.scope || payload.sid !== expected.storeId || payload.sub !== expected.subject.toLowerCase()) {
    return 'wrong_subject';
  }
  return 'ok';
}
