/**
 * Opaque keyset cursors for list endpoints ordered by `(created_at_ms DESC, id DESC)`. The cursor
 * carries only the position of the last row returned; it grants no access (every query is still
 * store-scoped), and a tampered cursor is simply rejected or yields a different window of the
 * caller's own rows.
 */

import { BadRequestError } from '../../shared/errors';

export interface Cursor {
  createdAtMs: number;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return btoa(`${cursor.createdAtMs}.${cursor.id}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const text = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const dot = text.indexOf('.');
    const ms = text.slice(0, dot);
    const id = text.slice(dot + 1);
    if (dot > 0 && /^\d{1,16}$/.test(ms) && UUID.test(id)) return { createdAtMs: Number(ms), id };
  } catch {
    // fall through
  }
  throw new BadRequestError('The cursor is not valid.');
}

/**
 * Cursor for the Orders list, ordered by `(linkedAt DESC, orderId DESC)`. Order ids are the platform's
 * own strings (not UUIDs), so this is a separate shape: base64url of `<iso>\n<orderId>` as UTF-8.
 */
export interface OrderCursor {
  linkedAt: string;
  orderId: string;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeOrderCursor(cursor: OrderCursor): string {
  const bytes = new TextEncoder().encode(`${cursor.linkedAt}\n${cursor.orderId}`);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeOrderCursor(raw: string | undefined): OrderCursor | null {
  if (!raw) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const newline = text.indexOf('\n');
    const linkedAt = text.slice(0, newline);
    const orderId = text.slice(newline + 1);
    if (newline > 0 && ISO_UTC.test(linkedAt) && orderId.length >= 1 && orderId.length <= 200) {
      return { linkedAt, orderId };
    }
  } catch {
    // fall through
  }
  throw new BadRequestError('The cursor is not valid.');
}
