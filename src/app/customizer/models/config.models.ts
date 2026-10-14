/**
 * JSON configuration contract (schema version 1).
 *
 * The same shapes are described by `public/schema/customizer-config.schema.json`.
 * After validation every `src` / `assetBaseUrl` in a `CustomizerConfig` held by the element
 * is an absolute http(s) URL.
 */

export const SCHEMA_VERSION = 1;

/** Deliberate v1 limits. Enforced by the validator and the image pipeline. */
export const LIMITS = {
  maxFields: 10,
  maxLayers: 20,
  maxFonts: 5,
  maxChoicesPerField: 20,
  maxTextGraphemes: 100,
  maxColorsPerField: 12,
  maxImageBytes: 10 * 1024 * 1024,
  /** Re-encoded canonical images can be larger than the original upload (e.g. an optimised PNG). */
  maxCanonicalBytes: 64 * 1024 * 1024,
  maxImageMegapixels: 25,
  maxOutputEdge: 4096,
  maxOutputMegapixels: 16,
  previewMaxEdge: 1200,
  /** Hard floors for the DPI thresholds; a configuration may only raise them. */
  minDpiFloor: 100,
  warnDpiFloor: 150,
  maxConfigBytes: 1024 * 1024,
} as const;

export type TextAlign = 'left' | 'center' | 'right';

export interface CanvasSpec {
  /** Artwork width in pixels (1..4096). */
  width: number;
  /** Artwork height in pixels (1..4096). */
  height: number;
  /** `transparent` or `#rgb` / `#rrggbb` / `#rrggbbaa`. */
  background: string;
}

export interface PrintSpec {
  widthMm: number;
  heightMm: number;
  /** Warn below this effective DPI. Never lower than 150. */
  warnDpi?: number;
  /** Block below this effective DPI. Never lower than 100. */
  minDpi?: number;
}

/** Normalised 0..1 rectangle relative to the natural size of the mockup image. */
export interface MockupPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MockupSpec {
  src: string;
  placement: MockupPlacement;
}

export interface FontSpec {
  id: string;
  /** Family name; the element registers the file under a collision-free internal name. */
  family: string;
  src: string;
  /** Optional name shown in the font picker (defaults to `family`). */
  label?: string;
}

interface FieldBase {
  id: string;
  label: string;
  helpText?: string;
  required: boolean;
}

export interface TextFieldDefault {
  text?: string;
  fontId?: string;
  color?: string;
}

export interface TextFieldSpec extends FieldBase {
  type: 'text';
  /** Maximum grapheme clusters (1..100). */
  maxLength: number;
  fontIds: string[];
  colors: string[];
  defaultValue?: TextFieldDefault;
}

export interface ImageFieldSpec extends FieldBase {
  type: 'image';
}

export interface ArtworkChoice {
  id: string;
  label: string;
  src: string;
  /** Optional smaller image for the choice card; defaults to `src`. */
  thumbnailSrc?: string;
}

export interface ArtworkFieldSpec extends FieldBase {
  type: 'artwork';
  choices: ArtworkChoice[];
  defaultChoiceId?: string;
}

export type FieldSpec = TextFieldSpec | ImageFieldSpec | ArtworkFieldSpec;

interface LayerBase {
  id: string;
  /** Canvas pixels, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageLayerSpec extends LayerBase {
  type: 'image';
  fieldId: string;
}

export interface TextLayerSpec extends LayerBase {
  type: 'text';
  fieldId: string;
  fontSize: number;
  minFontSize: number;
  align: TextAlign;
}

export interface ArtworkLayerSpec extends LayerBase {
  type: 'artwork';
  fieldId: string;
}

export interface FixedImageLayerSpec extends LayerBase {
  type: 'fixed-image';
  src: string;
}

export type LayerSpec = ImageLayerSpec | TextLayerSpec | ArtworkLayerSpec | FixedImageLayerSpec;

export interface DisplayPriceSpec {
  /** ISO 4217 code, e.g. `INR`. */
  currency: string;
  /** Minor-unit exponent (0..4). 2 means 49900 is 499.00. */
  exponent: number;
  baseMinor: number;
  customizationFeeMinor: number;
}

export interface ProductSpec {
  id: string;
  variantId?: string;
  name: string;
}

export interface CustomizerConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  templateId: string;
  templateVersion: number;
  product: ProductSpec;
  assetBaseUrl?: string;
  canvas: CanvasSpec;
  print?: PrintSpec;
  mockup: MockupSpec;
  fonts: FontSpec[];
  fields: FieldSpec[];
  /** Back-to-front. */
  layers: LayerSpec[];
  displayPrice?: DisplayPriceSpec;
}

/** One problem found while validating a configuration. */
export interface ConfigIssue {
  /** JSON-pointer-like location, e.g. `layers[2].fieldId`. */
  path: string;
  code: string;
  message: string;
}
