/**
 * Worker bindings and runtime configuration.
 *
 * `Env` is the raw set of bindings/vars Cloudflare injects (declared in wrangler.jsonc). `AppConfig`
 * is the parsed, validated view the rest of the app consumes, so no handler reads `env.*` strings
 * directly. Secrets (the DB password inside the Hyperdrive connection string, the JWT signing key)
 * are provided through `wrangler secret` / `.dev.vars` and are never committed.
 */

export interface Env {
  /** Pooled Postgres connection, created with `wrangler hyperdrive create`. */
  HYPERDRIVE: Hyperdrive;
  /**
   * R2 binding for artwork, images, mockups, thumbnails and previews. Required when STORAGE_DRIVER is
   * `r2` (production). Not needed for `s3`.
   */
  PERSONALIZATION_ASSETS?: R2Bucket;

  // ---- non-secret vars (wrangler.jsonc > vars) ----
  ENVIRONMENT?: string;
  API_VERSION?: string;
  CORS_ALLOWED_ORIGINS?: string;
  ASSET_PUBLIC_BASE_URL?: string;
  MAX_UPLOAD_BYTES?: string;
  LOG_LEVEL?: string;
  /** `r2` (production, uses the binding) or `s3` (local / dev / staging). Defaults to `r2`. */
  STORAGE_DRIVER?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  /** Optional S3-compatible endpoint (for example MinIO). Leave unset for AWS. */
  S3_ENDPOINT?: string;
  /** Public storefront limiter: requests allowed per store + client IP per window (default 120). */
  STOREFRONT_RATE_LIMIT?: string;
  /** Public storefront limiter window in seconds (default 60). */
  STOREFRONT_RATE_WINDOW_SECONDS?: string;
  /** Public customer WRITE limiter (uploads, saving a customization): requests per window (default 30). */
  STOREFRONT_WRITE_RATE_LIMIT?: string;
  /** Order-callback limiter: requests per client IP per window (default 600). */
  ORDER_CALLBACK_RATE_LIMIT?: string;
  /** Accepted clock skew / replay window for signed order callbacks, in seconds (default 300). */
  ORDER_CALLBACK_TOLERANCE_SECONDS?: string;
  /** Inactivity period after which a saved, unordered customization expires, in days (default 30). */
  CUSTOMIZATION_RETENTION_DAYS?: string;
  /** Lifetime of a customer access / upload token, in seconds (default 604800 = 7 days). */
  CUSTOMIZATION_TOKEN_TTL_SECONDS?: string;
  /** Hours an upload may stay unattached before cleanup releases it (default 24). */
  UNATTACHED_UPLOAD_TTL_HOURS?: string;
  /** Hours between releasing a customer asset and deleting its object (default 24). */
  ASSET_DELETE_GRACE_HOURS?: string;
  /** Days an expired customization row is kept (cleared of data) before it is purged (default 30). */
  EXPIRED_TOMBSTONE_DAYS?: string;

  // ---- secrets (wrangler secret put / .dev.vars) ----
  /**
   * HMAC key used to verify the HS256 session tokens the hosting platform (ZenBasket) issues. The
   * Worker never mints tokens; it only verifies them. Required in staging/production.
   */
  JWT_SIGNING_SECRET?: string;
  /**
   * Key for signed asset URLs (see modules/personalization/asset-signature.ts). Falls back to
   * JWT_SIGNING_SECRET when unset; set it separately so rotating one does not break the other.
   */
  ASSET_SIGNING_SECRET?: string;
  /**
   * Development-only static bearer token. When set AND ENVIRONMENT !== 'production', a request with
   * `Authorization: Bearer <DEV_AUTH_TOKEN>` is treated as the dev store identified by DEV_STORE_ID.
   * Never set this in production.
   */
  DEV_AUTH_TOKEN?: string;
  DEV_STORE_ID?: string;
  /**
   * 32-byte key (base64 or base64url) that encrypts per-store integration secrets at rest in
   * Postgres (AES-256-GCM). Required to create credentials or verify signed callbacks. Never log it,
   * never commit it, and keep it out of `wrangler.jsonc`: `wrangler secret put INTEGRATION_ENCRYPTION_KEY`.
   */
  INTEGRATION_ENCRYPTION_KEY?: string;
  /**
   * HMAC key for the scoped, expiring tokens handed to customers (customization access + upload
   * tokens). Independent of every other secret so rotating one never breaks another.
   */
  CUSTOMIZATION_TOKEN_SECRET?: string;
  /** IAM user limited to the S3 bucket. Only needed when STORAGE_DRIVER is `s3`. */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /**
   * Only for temporary credentials (access keys starting with `ASIA`, from STS / SSO). Temporary
   * credentials expire, so use long-term IAM user keys for staging.
   */
  AWS_SESSION_TOKEN?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type StorageDriver = 'r2' | 's3';

export interface AppConfig {
  environment: 'development' | 'staging' | 'production';
  apiVersion: string;
  /** Normalised CORS origin allowlist (lowercased, no trailing slash). Empty = allow none. */
  corsAllowedOrigins: readonly string[];
  /** Optional public delivery base for intentionally-public assets (an R2 custom domain). */
  assetPublicBaseUrl: string | null;
  maxUploadBytes: number;
  logLevel: LogLevel;
  jwtSigningSecret: string | null;
  assetSigningSecret: string | null;
  devAuthToken: string | null;
  devStoreId: string | null;
  storageDriver: StorageDriver;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  storefrontRateLimit: number;
  storefrontRateWindowSeconds: number;
  storefrontWriteRateLimit: number;
  orderCallbackRateLimit: number;
  orderCallbackToleranceSeconds: number;
  customizationRetentionDays: number;
  customizationTokenTtlSeconds: number;
  unattachedUploadTtlHours: number;
  assetDeleteGraceHours: number;
  expiredTombstoneDays: number;
  integrationEncryptionKey: string | null;
  customizationTokenSecret: string | null;
}

const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const DEFAULT_STOREFRONT_RATE_LIMIT = 120;
const DEFAULT_STOREFRONT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_STOREFRONT_WRITE_RATE_LIMIT = 30;
const DEFAULT_ORDER_CALLBACK_RATE_LIMIT = 600;
const DEFAULT_ORDER_CALLBACK_TOLERANCE_SECONDS = 300;
const DEFAULT_CUSTOMIZATION_RETENTION_DAYS = 30;
const DEFAULT_CUSTOMIZATION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_UNATTACHED_UPLOAD_TTL_HOURS = 24;
const DEFAULT_ASSET_DELETE_GRACE_HOURS = 24;
const DEFAULT_EXPIRED_TOMBSTONE_DAYS = 30;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim().toLowerCase().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
}

function parseLogLevel(raw: string | undefined): LogLevel {
  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

function parseStorageDriver(raw: string | undefined): StorageDriver {
  return raw === 's3' ? 's3' : 'r2';
}

function parseEnvironment(raw: string | undefined): AppConfig['environment'] {
  return raw === 'staging' || raw === 'production' ? raw : 'development';
}

let cached: { env: Env; config: AppConfig } | null = null;

/** Parse (and cache per-isolate) the validated runtime config from the raw bindings. */
export function loadConfig(env: Env): AppConfig {
  if (cached && cached.env === env) return cached.config;
  const maxUpload = Number(env.MAX_UPLOAD_BYTES);
  const config: AppConfig = {
    environment: parseEnvironment(env.ENVIRONMENT),
    apiVersion: env.API_VERSION?.trim() || 'v1',
    corsAllowedOrigins: parseOrigins(env.CORS_ALLOWED_ORIGINS),
    assetPublicBaseUrl: env.ASSET_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null,
    maxUploadBytes: Number.isFinite(maxUpload) && maxUpload > 0 ? maxUpload : DEFAULT_MAX_UPLOAD_BYTES,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    jwtSigningSecret: env.JWT_SIGNING_SECRET?.trim() || null,
    assetSigningSecret: env.ASSET_SIGNING_SECRET?.trim() || env.JWT_SIGNING_SECRET?.trim() || null,
    devAuthToken: env.DEV_AUTH_TOKEN?.trim() || null,
    devStoreId: env.DEV_STORE_ID?.trim() || null,
    storageDriver: parseStorageDriver(env.STORAGE_DRIVER),
    s3Bucket: env.S3_BUCKET?.trim() || null,
    s3Region: env.S3_REGION?.trim() || null,
    s3Endpoint: env.S3_ENDPOINT?.trim().replace(/\/+$/, '') || null,
    storefrontRateLimit: positiveInt(env.STOREFRONT_RATE_LIMIT, DEFAULT_STOREFRONT_RATE_LIMIT),
    storefrontRateWindowSeconds: positiveInt(
      env.STOREFRONT_RATE_WINDOW_SECONDS,
      DEFAULT_STOREFRONT_RATE_WINDOW_SECONDS,
    ),
    storefrontWriteRateLimit: positiveInt(env.STOREFRONT_WRITE_RATE_LIMIT, DEFAULT_STOREFRONT_WRITE_RATE_LIMIT),
    orderCallbackRateLimit: positiveInt(env.ORDER_CALLBACK_RATE_LIMIT, DEFAULT_ORDER_CALLBACK_RATE_LIMIT),
    orderCallbackToleranceSeconds: positiveInt(
      env.ORDER_CALLBACK_TOLERANCE_SECONDS,
      DEFAULT_ORDER_CALLBACK_TOLERANCE_SECONDS,
    ),
    customizationRetentionDays: positiveInt(env.CUSTOMIZATION_RETENTION_DAYS, DEFAULT_CUSTOMIZATION_RETENTION_DAYS),
    customizationTokenTtlSeconds: positiveInt(
      env.CUSTOMIZATION_TOKEN_TTL_SECONDS,
      DEFAULT_CUSTOMIZATION_TOKEN_TTL_SECONDS,
    ),
    unattachedUploadTtlHours: positiveInt(env.UNATTACHED_UPLOAD_TTL_HOURS, DEFAULT_UNATTACHED_UPLOAD_TTL_HOURS),
    assetDeleteGraceHours: positiveInt(env.ASSET_DELETE_GRACE_HOURS, DEFAULT_ASSET_DELETE_GRACE_HOURS),
    expiredTombstoneDays: positiveInt(env.EXPIRED_TOMBSTONE_DAYS, DEFAULT_EXPIRED_TOMBSTONE_DAYS),
    integrationEncryptionKey: env.INTEGRATION_ENCRYPTION_KEY?.trim() || null,
    customizationTokenSecret: env.CUSTOMIZATION_TOKEN_SECRET?.trim() || null,
  };
  cached = { env, config };
  return config;
}
