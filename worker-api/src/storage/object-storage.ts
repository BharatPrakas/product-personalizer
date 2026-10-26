/**
 * Storage contract for personalization binaries. The service layer depends only on this interface,
 * so the backing store can change per environment:
 *   - production: Cloudflare R2 (`R2ObjectStorage`, via the Worker binding)
 *   - local / dev / staging: AWS S3 (`S3ObjectStorage`, via the S3 REST API with SigV4)
 *
 * Object keys are generated server-side (see `generateObjectKey`); callers never choose them.
 */

import type { DetectedImageType } from '../shared/image-sniff';

const EXTENSION: Record<DetectedImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** A client-supplied id is never used as (part of) a key verbatim. */
function safeSegment(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
  // Fall back to a stable hash so odd / hostile ids cannot escape the prefix.
  let hash = 5381;
  for (let i = 0; i < trimmed.length; i++) hash = ((hash << 5) + hash + trimmed.charCodeAt(i)) >>> 0;
  return `s${hash.toString(16)}`;
}

/**
 * Storage layout (one bucket per environment):
 *
 *   plugins/<plugin-folder>/...                       plugin code bundles (storefront.js, store-admin.js)
 *   stores/<store>/<plugin-folder>/assets/<file>      per-store, per-plugin assets (this module)
 *
 * Every plugin writes only under its own `<plugin-folder>`, inside the tenant's `stores/<store>/` prefix,
 * so artwork and customer images of one plugin never mix with another plugin's or another store's.
 */
const FOLDER_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/** A plugin's storage folder is a developer-defined constant, so it is validated, not hashed. */
export function assertStorageFolder(folder: string): string {
  if (!FOLDER_PATTERN.test(folder)) {
    throw new Error(`Invalid plugin storage folder "${folder}". Use lowercase letters, digits and hyphens.`);
  }
  return folder;
}

export interface KeyParts {
  /** The plugin's storage folder, e.g. `product-personalization`. */
  storageFolder: string;
  storeId: string;
  type: DetectedImageType;
}

/** `stores/<store>/<plugin-folder>/assets/` — everything one plugin stores for one store. */
export function assetKeyPrefix(storeId: string, storageFolder: string): string {
  return `stores/${safeSegment(storeId)}/${assertStorageFolder(storageFolder)}/assets/`;
}

/**
 * `stores/<store>/<plugin-folder>/assets/<uuid>.<ext>`. Built from sanitized, tenant-scoped parts so a
 * client can never influence the key or climb the tree.
 */
export function generateObjectKey({ storageFolder, storeId, type }: KeyParts): string {
  const key = `${assetKeyPrefix(storeId, storageFolder)}${crypto.randomUUID()}.${EXTENSION[type]}`;
  if (key.includes('..') || key.startsWith('/') || key.includes('//')) {
    throw new Error('Refusing to build an unsafe object key.');
  }
  return key;
}

export interface PutOptions {
  contentType: string;
  /** Hex SHA-256 of the bytes, recorded in the database for integrity checks. */
  sha256?: string;
  /** Stamped on the object as ownership metadata (defence in depth; the database is authoritative). */
  storeId: string;
}

export interface StoredObject {
  size: number;
  etag: string;
}

export interface FetchedObject {
  body: ReadableStream;
  size: number;
  etag: string;
  contentType: string;
}

export interface ObjectStorage {
  put(key: string, body: ArrayBuffer | ReadableStream, opts: PutOptions): Promise<StoredObject>;
  head(key: string): Promise<StoredObject | null>;
  get(key: string): Promise<FetchedObject | null>;
  /** Deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

/** Raised when a storage backend is selected but not configured, or the backend call fails. */
export class StorageConfigError extends Error {}
export class StorageRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    // Status and operation only: no URLs, keys or credentials reach logs or responses.
    super(`Object storage ${operation} failed with HTTP ${status}.`);
    this.name = 'StorageRequestError';
  }
}
