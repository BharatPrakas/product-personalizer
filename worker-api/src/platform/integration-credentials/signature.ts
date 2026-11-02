/**
 * Request signing for server-to-server callbacks.
 *
 *   X-ZB-Key-Id:     <credential id>
 *   X-ZB-Timestamp:  <unix seconds>
 *   X-ZB-Signature:  v1=<hex HMAC-SHA256( secret, "<timestamp>.<exact raw request body>" )>
 *
 * The timestamp is part of the signed message, so a captured request cannot be replayed with a fresh
 * timestamp, and the verifier rejects timestamps outside a short window. Comparison is constant-time.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_VERSION = 'v1';

export function signBody(secret: string, timestampSeconds: number | string, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `${SIGNATURE_VERSION}=${digest}`;
}

/** Constant-time comparison of a presented signature header against the expected one. */
export function signatureMatches(secret: string, timestampSeconds: string, rawBody: string, presented: string): boolean {
  const expected = Buffer.from(signBody(secret, timestampSeconds, rawBody));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(expected, given);
}

export type TimestampCheck = { ok: true; seconds: number } | { ok: false };

/** Accepts only plain integer seconds within ±`toleranceSeconds` of `nowMs`. */
export function checkTimestamp(raw: string | undefined, nowMs: number, toleranceSeconds: number): TimestampCheck {
  if (!raw || !/^\d{9,12}$/.test(raw)) return { ok: false };
  const seconds = Number(raw);
  return Math.abs(nowMs / 1000 - seconds) <= toleranceSeconds ? { ok: true, seconds } : { ok: false };
}
