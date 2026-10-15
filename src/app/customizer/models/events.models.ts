import type {
  Customization,
  FieldError,
  SavedAreaArtwork,
  SavedAsset,
  SavedPreview,
} from './draft.models';

export type CustomizerErrorCode =
  | 'invalid-config'
  | 'config-conflict'
  | 'config-load-failed'
  | 'font-load-failed'
  | 'asset-load-failed'
  | 'asset-cors'
  | 'asset-missing'
  | 'restore-mismatch'
  | 'export-failed'
  | 'unexpected';

/** Acknowledgement the host assigns to `saveResult`. */
export interface SaveResult {
  requestId: string;
  status: 'success' | 'error';
  message?: string;
}

export interface CustomizerReadyDetail {
  productId: string;
  /** Configuration id (`templateId` in schema version 1). */
  templateId: string;
  /** Configuration version (`templateVersion` in schema version 1). */
  templateVersion: number;
  /** Present for schema-version-2 configurations only (version-1 detail is unchanged). */
  schemaVersion?: 2;
}

export interface CustomizerChangeDetail {
  draft: Customization;
  valid: boolean;
  dirty: boolean;
  errors: FieldError[];
}

export interface CustomizerSaveDetail {
  /** Unique per newly frozen draft; reused unchanged when the shopper retries after a timeout. */
  requestId: string;
  customization: Customization;
  /** Mockup + artwork of the first active mockup, longest edge at most 1200px. */
  previewBlob: Blob;
  /** Artwork of the first active printable area, at its configured canvas pixel size. */
  artworkBlob: Blob;
  /** Schema v2: one production artwork per active printable area, each from its own canvas. */
  artworks: SavedAreaArtwork[];
  /** Schema v2: a composite preview per active mockup. */
  previews: SavedPreview[];
  /** Canonical uploaded images referenced by `customization`. */
  assets: SavedAsset[];
}

export interface CustomizerErrorDetail {
  code: CustomizerErrorCode;
  /** Sanitised; never includes shopper text or photo content. */
  message: string;
  fieldId?: string;
  recoverable: boolean;
}
