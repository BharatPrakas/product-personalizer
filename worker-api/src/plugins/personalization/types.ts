/**
 * Personalization types.
 *
 * The rendering configuration (`ProductConfig`, schema v2) is defined and owned by the Angular app.
 * The backend treats it as an opaque-but-structured JSON document: it validates the envelope and
 * limits (validation.ts) and reads a few fields for metadata, but never reshapes the renderer's
 * model. `ProductConfigLike` captures only what the backend touches.
 */

/** Folder under `stores/<store>/` for this service's assets (artwork, customer images, mockups). */
export const STORAGE_FOLDER = 'product-personalization';

/** The subset of ProductConfig the backend reads. The rest is preserved verbatim. */
export interface ProductConfigLike {
  schemaVersion: number;
  id?: string;
  version?: number;
  status?: string;
  product?: { id?: string; name?: string };
  variants?: unknown[];
  mockups?: unknown[];
  printableAreas?: unknown[];
  artworks?: unknown[];
  fonts?: unknown[];
  fields?: unknown[];
  [key: string]: unknown;
}

/**
 * Mirrors the Angular `ConfigurationRecord` exactly (id, draft, published, and the four epoch-ms
 * stamps), so the cloud repository is a near drop-in for the local one. `id` is the client-facing id
 * (stable across local cache and cloud); the server uuid stays internal.
 */
export interface ConfigRecordDto {
  id: string;
  draft: ProductConfigLike;
  published: ProductConfigLike | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  archivedAt: number | null;
  /** How many product / variant / collection mappings point at this configuration. */
  mappingCount?: number;
}

export interface ConfigVersionSummaryDto {
  versionId: string;
  version: number;
  createdAt: number;
}

export interface ConfigVersionDto extends ConfigVersionSummaryDto {
  snapshot: ProductConfigLike;
}

export type AssetStatus = 'pending' | 'stored' | 'deleted';

export interface AssetDto {
  id: string;
  storeId: string;
  configId: string | null;
  objectKey: string;
  originalFilename: string | null;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  checksumSha256: string | null;
  status: AssetStatus;
  clientRef: string | null;
  createdAt: number;
  /** Stable delivery URL for the renderer (public base, or the authorized Worker endpoint). */
  deliveryUrl: string;
}

// ---- mappings & markups ---------------------------------------------------------------------------

export type MappingScope = 'product' | 'variant' | 'collection';
export type MarkupKind = 'area' | 'artwork';
/** Derived lifecycle state of the mapped configuration. */
export type ConfigLifecycleStatus = 'draft' | 'published' | 'archived';

export interface MappingDto {
  id: string;
  storeId: string;
  /** The configuration's client-facing id (`ConfigRecordDto.id`), not the internal uuid. */
  configId: string;
  configName: string;
  configStatus: ConfigLifecycleStatus;
  scope: MappingScope;
  externalId: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MappingConflictDto {
  scope: MappingScope;
  externalId: string;
  existing: { id: string; configId: string; configName: string };
}

export interface MarkupDto {
  id: string;
  storeId: string;
  name: string;
  kind: MarkupKind;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CursorPageMeta {
  limit: number;
  /** Opaque; pass back as `?cursor=` to fetch the next page. `null` when there are no more rows. */
  nextCursor: string | null;
  hasMore: boolean;
}
