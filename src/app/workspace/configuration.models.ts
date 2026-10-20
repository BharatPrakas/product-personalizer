/**
 * The workspace's unit of management: a configuration with a working draft and, once published,
 * an immutable published snapshot. Lifecycle:
 *
 *   create ──► draft ──publish──► published (draft continues as version + 1)
 *                 ▲                    │
 *                 └──── edit/save ─────┘  ("unpublished changes" while draft differs)
 *
 * Archiving hides a configuration from the default list without deleting it.
 */

import type { ProductConfig } from '../customizer/models/product.models';
import { stableKey } from '../customizer/util/values';

export interface ConfigurationRecord {
  id: string;
  /** The working copy the editor opens and saves. Always `status: 'draft'`. */
  draft: ProductConfig;
  /** The last published snapshot (`status: 'published'`), or null before the first publish. */
  published: ProductConfig | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  archivedAt: number | null;
}

export type ConfigurationStatus = 'draft' | 'published';

export interface ConfigurationSummary {
  id: string;
  name: string;
  status: ConfigurationStatus;
  /** True when a published configuration has newer draft edits. */
  hasUnpublishedChanges: boolean;
  archived: boolean;
  mockupCount: number;
  areaCount: number;
  artworkCount: number;
  updatedAt: number;
  publishedAt: number | null;
  /** Published version number, if any. */
  publishedVersion: number | null;
}

/** Content that changes what customers see; lifecycle bookkeeping is ignored. */
function contentKey(config: ProductConfig): string {
  return stableKey({ ...config, version: 0, status: 'draft' });
}

export function hasUnpublishedChanges(record: ConfigurationRecord): boolean {
  return !!record.published && contentKey(record.draft) !== contentKey(record.published);
}

export function summarize(record: ConfigurationRecord): ConfigurationSummary {
  const { draft } = record;
  return {
    id: record.id,
    name: draft.product.name,
    status: record.published ? 'published' : 'draft',
    hasUnpublishedChanges: hasUnpublishedChanges(record),
    archived: record.archivedAt !== null,
    mockupCount: draft.mockups.length,
    areaCount: draft.printableAreas.length,
    artworkCount: draft.artworks.length,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
    publishedVersion: record.published?.version ?? null,
  };
}

/** What an older build stored: a single configuration whose `status` doubled as the lifecycle. */
interface LegacyRecord {
  id: string;
  config: ProductConfig;
  updatedAt: number;
}

export function normalizeRecord(raw: ConfigurationRecord | LegacyRecord): ConfigurationRecord {
  if ('draft' in raw) return raw;
  const wasPublished = raw.config.status === 'published';
  return {
    id: raw.id,
    draft: wasPublished
      ? { ...raw.config, status: 'draft', version: raw.config.version + 1 }
      : raw.config,
    published: wasPublished ? raw.config : null,
    createdAt: raw.updatedAt,
    updatedAt: raw.updatedAt,
    publishedAt: wasPublished ? raw.updatedAt : null,
    archivedAt: null,
  };
}
