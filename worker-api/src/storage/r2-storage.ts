/**
 * Production object storage on Cloudflare R2, using the Worker binding. The Worker never exposes R2
 * credentials to the browser.
 */

import type { FetchedObject, ObjectStorage, PutOptions, StoredObject } from './object-storage';

export class R2ObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

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
    return object ? { size: object.size, etag: object.etag } : null;
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
}
