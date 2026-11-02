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
