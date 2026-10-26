/**
 * Consistent response envelopes. Success: `{ data, meta? }`. Error: `{ error: {...} }`. Every
 * response carries the request id so clients and logs can be correlated.
 */

import type { Context } from 'hono';
import type { ApiError } from './errors';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
  requestId: string;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

function requestIdOf(c: Context): string {
  return (c.get('requestId') as string | undefined) ?? 'unknown';
}

export function ok<T>(c: Context, data: T, status = 200, meta?: Record<string, unknown>): Response {
  const body: SuccessEnvelope<T> = { data, requestId: requestIdOf(c) };
  if (meta) body.meta = meta;
  return c.json(body, status as 200);
}

export function created<T>(c: Context, data: T, location?: string): Response {
  const res = ok(c, data, 201);
  if (location) res.headers.set('Location', location);
  return res;
}

export function noContent(c: Context): Response {
  return c.body(null, 204);
}

export function paginated<T>(c: Context, items: T[], page: PageMeta): Response {
  return ok(c, items, 200, { pagination: page });
}

export function errorResponse(c: Context, error: ApiError): Response {
  const body: ErrorEnvelope = {
    error: {
      code: error.code,
      message: error.clientSafe ? error.message : 'An unexpected error occurred.',
      requestId: requestIdOf(c),
      ...(error.clientSafe && error.details !== undefined ? { details: error.details } : {}),
    },
  };
  const res = c.json(body, error.status as 400);
  if (error.code === 'rate_limited' && 'retryAfterSeconds' in error) {
    res.headers.set('Retry-After', String((error as { retryAfterSeconds: number }).retryAfterSeconds));
  }
  return res;
}
