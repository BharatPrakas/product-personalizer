import type { Customization, FieldError, SavedAsset } from './draft.models';

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
  templateId: string;
  templateVersion: number;
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
  /** Mockup + artwork, longest edge at most 1200px. */
  previewBlob: Blob;
  /** Artwork only, at the configured canvas pixel size. */
  artworkBlob: Blob;
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
