/**
 * Chooses the object-storage backend for the current environment. Handlers call this once per
 * request and receive an `ObjectStorage`; they never see the backend or its credentials.
 *
 *   STORAGE_DRIVER=r2  -> Cloudflare R2 binding (`PERSONALIZATION_ASSETS`); browser URLs are presigned
 *                         against R2's S3 API with R2_* credentials (see r2-storage.ts)
 *   STORAGE_DRIVER=s3  -> AWS S3 (or an S3-compatible endpoint) with IAM credentials
 *
 * A misconfigured backend throws `StorageConfigError`, which becomes an opaque 500 and a server-side
 * log line that names the missing setting (never its value).
 */

import type { AppConfig, Env } from '../config/environment';
import { R2ObjectStorage } from './r2-storage';
import { S3ObjectStorage } from './s3-storage';
import { type ObjectStorage, StorageConfigError } from './object-storage';

export function createObjectStorage(env: Env, config: AppConfig): ObjectStorage {
  if (config.storageDriver === 'r2') {
    if (!env.PERSONALIZATION_ASSETS) {
      throw new StorageConfigError('STORAGE_DRIVER is r2 but the PERSONALIZATION_ASSETS binding is missing.');
    }
    // The S3-API credentials are optional here: they are only needed to presign browser URLs, and a
    // missing one is reported by `presignPut` / `presignGet` so every other route keeps working.
    const canPresign =
      config.r2S3Endpoint && config.r2BucketName && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY;
    return new R2ObjectStorage(
      env.PERSONALIZATION_ASSETS,
      canPresign
        ? {
            bucket: config.r2BucketName!,
            endpoint: config.r2S3Endpoint,
            accessKeyId: env.R2_ACCESS_KEY_ID!,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
          }
        : null,
    );
  }

  const missing: string[] = [];
  if (!config.s3Bucket) missing.push('S3_BUCKET');
  if (!config.s3Region) missing.push('S3_REGION');
  if (!env.AWS_ACCESS_KEY_ID) missing.push('AWS_ACCESS_KEY_ID');
  if (!env.AWS_SECRET_ACCESS_KEY) missing.push('AWS_SECRET_ACCESS_KEY');
  if (missing.length > 0) {
    throw new StorageConfigError(`STORAGE_DRIVER is s3 but these settings are missing: ${missing.join(', ')}.`);
  }
  return new S3ObjectStorage({
    bucket: config.s3Bucket!,
    region: config.s3Region!,
    accessKeyId: env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || null,
    endpoint: config.s3Endpoint,
  });
}
