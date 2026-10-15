/**
 * The serialisable customization (also used as the draft in `customizer-change`).
 * It never contains image bytes, `blob:` URLs, DOM nodes or canvas objects.
 */

import type { SCHEMA_VERSION, TextAlign } from './config.models';
import type { PRODUCT_SCHEMA_VERSION } from './product.models';

/** `[left, top, width, height]`, normalised 0..1 relative to the canonical oriented image. */
export type CropRect = readonly [left: number, top: number, width: number, height: number];

export interface TextValue {
  text: string;
  fontId: string;
  color: string;
  /** Schema v2 style flags; absent means "use the layer's setting". */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
}

export type QuarterTurns = 0 | 90 | 180 | 270;
export type ImageFitMode = 'cover' | 'contain';

export interface ImageValue {
  /** Local (`local-…`) or host-assigned durable asset id; `null` when no photo is chosen. */
  assetId: string | null;
  crop: CropRect | null;
  /** Schema v2: `contain` shows the whole photo inside the slot; absent means the layer's setting. */
  fit?: ImageFitMode;
  /** Schema v2: clockwise rotation of the photo itself, in quarter turns. Default 0. */
  rotation?: QuarterTurns;
}

export interface ArtworkValue {
  choiceId: string | null;
}

export type FieldValue = TextValue | ImageValue | ArtworkValue;

/** Host-supplied display price plus a snapshot of what the shopper saw. Never authoritative. */
export interface PriceSnapshot {
  currency: string;
  exponent: number;
  baseMinor: number;
  customizationFeeMinor: number;
  totalMinor: number;
  authoritative: false;
}

/** Draft of a schema-version-1 configuration (single canvas). */
export interface CustomizationV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  productId: string;
  variantId?: string;
  templateId: string;
  templateVersion: number;
  values: Record<string, FieldValue>;
  canvas: { width: number; height: number; background: string };
  print?: { widthMm: number; heightMm: number };
  displayPrice?: PriceSnapshot;
}

/** One printable area as it was personalized. */
export interface CustomizationArea {
  artworkId: string | null;
  canvas: { width: number; height: number };
}

/**
 * Draft of a schema-version-2 configuration. `values` holds only the fields that were active
 * (visible for the chosen variant, artwork and conditions) when the draft was taken.
 */
export interface CustomizationV2 {
  schemaVersion: typeof PRODUCT_SCHEMA_VERSION;
  productId: string;
  configId: string;
  configVersion: number;
  variantId: string;
  /** Printable area id -> artwork id, for every active area. */
  artworkSelection: Record<string, string>;
  values: Record<string, FieldValue>;
  /** Active areas with their independent canvas sizes. */
  areas: Record<string, CustomizationArea>;
  displayPrice?: PriceSnapshot;
}

export type Customization = CustomizationV1 | CustomizationV2;

export type FieldErrorCode =
  | 'required'
  | 'too-short'
  | 'file-type'
  | 'file-too-large'
  | 'image-too-small'
  | 'too-long'
  | 'newline'
  | 'unsupported-glyph'
  | 'text-overflow'
  | 'invalid-option'
  | 'missing-asset'
  | 'low-resolution'
  | 'invalid-crop';

/** A blocking problem with one field. */
export interface FieldError {
  fieldId: string;
  code: FieldErrorCode;
  message: string;
}

/** Canonical user-uploaded image handed to the host next to the JSON snapshot. */
export interface SavedAsset {
  assetId: string;
  blob: Blob;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** Artwork exported from one printable area's own production canvas (no mockup, no UI). */
export interface SavedAreaArtwork {
  printableAreaId: string;
  printableAreaName: string;
  artworkId: string | null;
  width: number;
  height: number;
  blob: Blob;
}

/** Composite product preview for one mockup. */
export interface SavedPreview {
  mockupId: string;
  mockupName: string;
  blob: Blob;
}

/** Host-provided durable references for asset ids found in `initialCustomization`. */
export type AssetMapInput =
  Readonly<Record<string, string | Blob>> | ReadonlyMap<string, string | Blob>;
