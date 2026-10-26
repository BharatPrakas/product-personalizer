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

  // ---- secrets (wrangler secret put / .dev.vars) ----
  /**
   * HMAC key used to verify the HS256 session tokens the hosting platform (ZenBasket) issues. The
   * Worker never mints tokens; it only verifies them. Required in staging/production.
   */
  JWT_SIGNING_SECRET?: string;
  /**
   * Development-only static bearer token. When set AND ENVIRONMENT !== 'production', a request with
   * `Authorization: Bearer <DEV_AUTH_TOKEN>` is treated as the dev store identified by DEV_STORE_ID.
   * Never set this in production.
   */
  DEV_AUTH_TOKEN?: string;
  DEV_STORE_ID?: string;
  /** IAM user limited to the S3 bucket. Only needed when STORAGE_DRIVER is `s3`. */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
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
  devAuthToken: string | null;
  devStoreId: string | null;
  storageDriver: StorageDriver;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  storefrontRateLimit: number;
  storefrontRateWindowSeconds: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const DEFAULT_STOREFRONT_RATE_LIMIT = 120;
const DEFAULT_STOREFRONT_RATE_WINDOW_SECONDS = 60;

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
  };
  cached = { env, config };
  return config;
}
