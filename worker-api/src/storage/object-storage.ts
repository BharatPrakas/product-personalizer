/**
 * Storage contract for personalization binaries. The service layer depends only on this interface,
 * so the backing store can change per environment:
 *   - production: Cloudflare R2 (`R2ObjectStorage`, via the Worker binding)
 *   - local / dev / staging: AWS S3 (`S3ObjectStorage`, via the S3 REST API with SigV4)
 *
 * Object keys are generated server-side (see `generateObjectKey`); callers never choose them.
 */

import type { DetectedImageType } from '../shared/image-sniff';
import type { DetectedFontType } from '../shared/font-sniff';

export type DetectedAssetType = DetectedImageType | DetectedFontType;

const EXTENSION: Record<DetectedAssetType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
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
 *   stores/<store>/product-personalization/assets/<file>           merchant assets (this module)
 *   stores/<store>/product-personalization/customizations/<file>   PRIVATE customer files
 *
 * Everything sits inside the tenant's `stores/<store>/` prefix, so one store's files never mix with
 * another's. The `product-personalization` segment namespaces this service inside a bucket that may be
 * shared with other services; every stored `object_key` already carries it, so it must not change.
 */
const NAMESPACE = 'product-personalization';

export interface KeyParts {
  storeId: string;
  type: DetectedAssetType;
}

/**
 * `stores/<store>/product-personalization/pending/` — INTERNAL staging area for direct browser
 * uploads. A presigned PUT only ever targets `pending/<uploadId>`; the Worker verifies the object and
 * then promotes (copies) it to its permanent `assets/` or `customizations/` key. Nothing under
 * `pending/` is ever served, listed or referenced by a configuration, so an unverified object can never
 * be published, and a signed URL that outlives the upload can only touch a throw-away staging key.
 */
export function pendingKeyPrefix(storeId: string): string {
  return `stores/${safeSegment(storeId)}/${NAMESPACE}/pending/`;
}

/** `stores/<store>/product-personalization/pending/<uploadId>` (the id is a server-generated UUID). */
export function pendingObjectKey(storeId: string, uploadId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    throw new Error('Refusing to build a pending key from a non-UUID upload id.');
  }
  return `${pendingKeyPrefix(storeId)}${uploadId.toLowerCase()}`;
}

/** `stores/<store>/product-personalization/assets/` — every merchant asset of one store. */
export function assetKeyPrefix(storeId: string): string {
  return `stores/${safeSegment(storeId)}/${NAMESPACE}/assets/`;
}

/**
 * `stores/<store>/product-personalization/assets/<uuid>.<ext>`. Built from sanitized, tenant-scoped
 * parts so a client can never influence the key or climb the tree.
 */
export function generateObjectKey({ storeId, type }: KeyParts): string {
  const key = `${assetKeyPrefix(storeId)}${crypto.randomUUID()}.${EXTENSION[type]}`;
  if (key.includes('..') || key.startsWith('/') || key.includes('//')) {
    throw new Error('Refusing to build an unsafe object key.');
  }
  return key;
}

/**
 * `stores/<store>/product-personalization/customizations/` — PRIVATE customer files (uploaded artwork,
 * rendered previews). Deliberately a sibling of `assets/`, never beneath it: the public asset route only
 * serves keys under `assets/`, so a customer file can never be delivered through it.
 */
export function customizationKeyPrefix(storeId: string): string {
  return `stores/${safeSegment(storeId)}/${NAMESPACE}/customizations/`;
}

/** `stores/<store>/product-personalization/customizations/<uuid>.<ext>`, built from sanitized parts only. */
export function generateCustomizationObjectKey({ storeId, type }: KeyParts): string {
  const key = `${customizationKeyPrefix(storeId)}${crypto.randomUUID()}.${EXTENSION[type]}`;
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
  /** Content-Type the object was stored with, when the backend reports it (HEAD/GET). */
  contentType?: string;
}

/** A request the BROWSER sends straight to the storage provider. Contains no credentials, only a signature. */
export interface PresignedRequest {
  url: string;
  method: 'PUT' | 'GET';
  /** Headers the browser MUST send unchanged: they are part of the signature. */
  headers: Record<string, string>;
  expiresIn: number;
}

export interface PresignPutOptions {
  /** Signed into the URL: the provider rejects an upload whose Content-Type differs. */
  contentType: string;
  expiresInSeconds: number;
}

export interface PresignGetOptions {
  expiresInSeconds: number;
}

export interface CopyOptions {
  contentType: string;
  storeId: string;
  sha256?: string;
  /** Fail (StoragePreconditionError) unless the source still has this ETag — closes the verify→promote race. */
  ifMatchEtag?: string;
}

export interface BoundedObject {
  bytes: Uint8Array;
  size: number;
  etag: string;
  contentType: string;
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
  /**
   * A short-lived URL the browser PUTs the file to. Scoped to exactly this key, this method and this
   * Content-Type. Throws StorageConfigError when signing credentials are not configured.
   */
  presignPut(key: string, opts: PresignPutOptions): Promise<PresignedRequest>;
  /** A short-lived URL for reading exactly this key. Never persist it. */
  presignGet(key: string, opts: PresignGetOptions): Promise<PresignedRequest>;
  /**
   * Reads the whole object into memory, but never more than `maxBytes` (throws ObjectTooLargeError
   * otherwise). Used by upload verification, which must inspect the real bytes.
   */
  readBytes(key: string, maxBytes: number): Promise<BoundedObject | null>;
  /** Server-side copy within the bucket (promotion of a verified upload). Idempotent for a fixed dest. */
  copy(sourceKey: string, destKey: string, opts: CopyOptions): Promise<StoredObject>;
}

/** The two ETag spellings (S3: `"abc"`, R2 binding: `abc`) must compare equal. */
export function sameEtag(a: string, b: string): boolean {
  const clean = (v: string) => v.replace(/^W\//, '').replace(/^"|"$/g, '');
  return clean(a) === clean(b);
}

/** Reads a stream fully but aborts as soon as it exceeds `maxBytes`. */
export async function readLimited(stream: ReadableStream, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ObjectTooLargeError();
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class ObjectTooLargeError extends Error {
  constructor() {
    super('The stored object is larger than allowed.');
    this.name = 'ObjectTooLargeError';
  }
}

/** A conditional copy failed because the source object changed (or vanished) since it was verified. */
export class StoragePreconditionError extends Error {
  constructor() {
    super('The source object changed before it could be promoted.');
    this.name = 'StoragePreconditionError';
  }
}

/** Raised when a storage backend is selected but not configured, or the backend call fails. */
export class StorageConfigError extends Error {}
export class StorageRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    /** The backend's error code (for example S3's `AccessDenied`), when it returned one. */
    readonly code?: string,
  ) {
    // Operation, status and the backend's error code only: no URLs, keys or credentials reach logs or
    // responses. Clients still see an opaque 500.
    super(`Object storage ${operation} failed with HTTP ${status}${code ? ` (${code})` : ''}.`);
    this.name = 'StorageRequestError';
  }
}
