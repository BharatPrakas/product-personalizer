/**
 * Production object storage on Cloudflare R2.
 *
 * Server-side operations (put / head / get / delete / copy / bounded read) use the Worker binding.
 * A binding cannot mint browser-usable URLs, so direct browser transfer goes through R2's S3-compatible
 * API with SigV4 query signing: an `S3ObjectStorage` pointed at
 * `https://<account>.r2.cloudflarestorage.com` (path style, region `auto`) is used for presigning ONLY.
 * Presigned URLs therefore always target the R2 S3 endpoint — never a public custom domain. The R2 API
 * token is supplied as Worker secrets and never reaches the browser.
 */

import type {
  BoundedObject,
  CopyOptions,
  FetchedObject,
  ObjectStorage,
  PresignGetOptions,
  PresignPutOptions,
  PresignedRequest,
  PutOptions,
  StoredObject,
} from './object-storage';
import { ObjectTooLargeError, StorageConfigError, StoragePreconditionError, readLimited } from './object-storage';
import { S3ObjectStorage, type S3StorageSettings } from './s3-storage';

/** Credentials for R2's S3 API (an R2 API token scoped to this one bucket, Object Read & Write). */
export type R2PresignSettings = Pick<S3StorageSettings, 'bucket' | 'accessKeyId' | 'secretAccessKey' | 'endpoint' | 'signingTime'>;

export class R2ObjectStorage implements ObjectStorage {
  private readonly signer: S3ObjectStorage | null;

  constructor(
    private readonly bucket: R2Bucket,
    presign: R2PresignSettings | null = null,
  ) {
    this.signer = presign ? new S3ObjectStorage({ ...presign, region: 'auto' }) : null;
  }

  private requireSigner(): S3ObjectStorage {
    if (!this.signer) {
      throw new StorageConfigError(
        'Direct uploads on R2 need R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.',
      );
    }
    return this.signer;
  }

  async put(key: string, body: ArrayBuffer | ReadableStream, opts: PutOptions): Promise<StoredObject> {
    const object = await this.bucket.put(key, body, {
      httpMetadata: { contentType: opts.contentType },
      // Stamp ownership on the object itself as defence in depth (the DB remains authoritative).
      customMetadata: { storeId: opts.storeId },
      ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
    });
    if (!object) throw new Error('R2 put returned no object.');
    return { size: object.size, etag: object.etag };
  }

  async head(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.head(key);
    return object
      ? { size: object.size, etag: object.etag, contentType: object.httpMetadata?.contentType }
      : null;
  }

  async get(key: string): Promise<FetchedObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      size: object.size,
      etag: object.etag,
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedRequest> {
    return this.requireSigner().presignPut(key, opts);
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<PresignedRequest> {
    return this.requireSigner().presignGet(key, opts);
  }

  async readBytes(key: string, maxBytes: number): Promise<BoundedObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    if (object.size > maxBytes) {
      await object.body.cancel().catch(() => undefined);
      throw new ObjectTooLargeError();
    }
    const bytes = await readLimited(object.body, maxBytes);
    return {
      bytes,
      size: bytes.byteLength,
      etag: object.etag,
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  /**
   * R2 bindings have no CopyObject; stream the source into a put on the destination. The bytes move
   * inside Cloudflare's network (get -> put), they never reach a browser. `onlyIf.etagMatches` makes the
   * read fail when the staging object changed since it was verified.
   */
  async copy(sourceKey: string, destKey: string, opts: CopyOptions): Promise<StoredObject> {
    const source = await this.bucket.get(
      sourceKey,
      opts.ifMatchEtag ? { onlyIf: { etagMatches: opts.ifMatchEtag.replace(/^"|"$/g, '') } } : undefined,
    );
    // A failed precondition returns the object WITHOUT a body; a missing object returns null.
    if (!source || !('body' in source) || !source.body) throw new StoragePreconditionError();
    const written = await this.bucket.put(destKey, source.body, {
      httpMetadata: { contentType: opts.contentType },
      customMetadata: { storeId: opts.storeId },
      ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
    });
    if (!written) throw new Error('R2 put returned no object.');
    return { size: written.size, etag: written.etag, contentType: opts.contentType };
  }
}
