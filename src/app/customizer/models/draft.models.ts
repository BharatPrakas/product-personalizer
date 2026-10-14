/**
 * The serialisable customization (also used as the draft in `customizer-change`).
 * It never contains image bytes, `blob:` URLs, DOM nodes or canvas objects.
 */

import { SCHEMA_VERSION } from './config.models';

/** `[left, top, width, height]`, normalised 0..1 relative to the canonical oriented image. */
export type CropRect = readonly [left: number, top: number, width: number, height: number];

export interface TextValue {
  text: string;
  fontId: string;
  color: string;
}

export interface ImageValue {
  /** Local (`local-…`) or host-assigned durable asset id; `null` when no photo is chosen. */
  assetId: string | null;
  crop: CropRect | null;
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

export interface Customization {
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

export type FieldErrorCode =
  | 'required'
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

/** Host-provided durable references for asset ids found in `initialCustomization`. */
export type AssetMapInput =
  Readonly<Record<string, string | Blob>> | ReadonlyMap<string, string | Blob>;
