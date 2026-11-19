/**
 * Product-personalization configuration (schema version 2).
 *
 * Coordinate systems (all independent of each other):
 *  - Production canvas: every printable area has its own pixel canvas (`area.canvas`), origin
 *    top-left. Layers live in this space (`x`, `y`, `width`, `height` in canvas pixels, rotation in
 *    degrees clockwise about the layer centre).
 *  - Mockup: placements are normalised 0..1 against the natural size of the mockup photograph
 *    (origin top-left). They never reference canvas pixels, so resizing the editor or the browser
 *    cannot change saved design coordinates.
 *  - Shapes: a `ShapeSpec` is always "fitted to a box"; a path is authored in its own `viewBox`
 *    and scaled to the box it is applied to (the area canvas, or a layer).
 *
 * Z-order of layers is their array order, back to front.
 * Version 1 configurations (`CustomizerConfig`) are upgraded to this model at load time.
 */

import type {
  CanvasSpec,
  DisplayPriceSpec,
  FieldSpec,
  FontSpec,
  PrintSpec,
  ProductSpec,
  TextAlign,
} from './config.models';

export const PRODUCT_SCHEMA_VERSION = 2;

/** Limits for schema version 2 (version 1 keeps its own, smaller limits in `LIMITS`). */
export const PRODUCT_LIMITS = {
  maxVariants: 40,
  maxMockups: 16,
  maxOverlaysPerMockup: 6,
  maxAreas: 16,
  maxArtworks: 48,
  maxLayersPerArtwork: 80,
  maxFields: 80,
  maxFonts: 8,
  maxTextLength: 500,
  maxPathLength: 20_000,
  maxConfigBytes: 4 * 1024 * 1024,
} as const;

export type ConfigStatus = 'draft' | 'published';

export type ShapeSpec =
  | {
      type: 'rect';
      /** Corner radius as a fraction of the shorter side (0..0.5). */
      cornerRadius?: number;
    }
  | { type: 'ellipse' }
  | {
      type: 'path';
      /** SVG path data (`d` attribute), authored inside `viewBox`. */
      d: string;
      /** `[width, height]` of the coordinate space `d` is drawn in. */
      viewBox: readonly [number, number];
    };

export type ShapeKind = ShapeSpec['type'];

export interface BoundarySpec {
  visible: boolean;
  /** `#rrggbb`. Editing aid only; never part of exported artwork. */
  color: string;
  /** 0..1. */
  opacity: number;
}

export interface PrintableArea {
  id: string;
  name: string;
  enabled: boolean;
  canvas: CanvasSpec;
  /** Clipping mask for the production artwork (and therefore the printed shape). */
  shape: ShapeSpec;
  /** Optional physical print size; enables effective-resolution warnings. */
  print?: PrintSpec;
  /** The artwork shown by default. Must be one of `artworkIds`. */
  artworkId: string;
  /** Compatible artwork options (includes `artworkId`). More than one makes the customer choose. */
  artworkIds: string[];
  boundary?: BoundarySpec;
}

export type LayerFit = 'cover' | 'contain';

interface LayerBase {
  id: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise about the layer centre. Default 0. */
  rotation?: number;
  /** 0..1. Default 1. */
  opacity?: number;
  /** Default true. Hidden layers are neither rendered nor do they create customer fields. */
  visible?: boolean;
  /** Merchant-editor lock; no effect on rendering. */
  locked?: boolean;
  /** Optional clipping shape, fitted to the layer box. */
  clip?: ShapeSpec | null;
}

export interface FixedImageLayer extends LayerBase {
  type: 'fixed-image';
  src: string;
  fit?: LayerFit | 'stretch';
}

/** A slot for a customer upload. `fieldId` names the image field that feeds it. */
export interface ImagePlaceholderLayer extends LayerBase {
  type: 'image-placeholder';
  fieldId: string;
  fit?: LayerFit;
  /** Shown in the (preview-only) empty slot; defaults to the field label. */
  placeholderLabel?: string;
}

/** Customer text when `fieldId` is set, otherwise fixed text from `text`. */
export interface TextLayer extends LayerBase {
  type: 'text';
  fieldId?: string;
  /** Fixed content (ignored when `fieldId` is set). */
  text?: string;
  /** Font for fixed text; editable text uses the font chosen in its field. */
  fontId?: string;
  fontSize: number;
  /** Auto-fit shrinks the text down to this size when it does not fit. */
  minFontSize: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align: TextAlign;
  /** Wrap onto several lines inside the layer box (default false: one line, shrink to fit). */
  wrap?: boolean;
  /** Multiple of the font size; default 1.2. */
  lineHeight?: number;
  verticalAlign?: 'top' | 'middle' | 'bottom';
}

/** Predefined artwork / clipart picked by the customer from an `artwork` field. */
export interface ArtworkChoiceLayer extends LayerBase {
  type: 'artwork';
  fieldId: string;
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: ShapeSpec;
  /** `transparent` or `#rgb[a]` / `#rrggbb[aa]`. */
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

export type ArtworkLayer =
  FixedImageLayer | ImagePlaceholderLayer | TextLayer | ArtworkChoiceLayer | ShapeLayer;

export type ArtworkLayerType = ArtworkLayer['type'];

export interface Artwork {
  id: string;
  name: string;
  printableAreaId: string;
  /** Overrides the area background when set. `transparent` or a hex colour. */
  background?: string;
  /** Back to front. */
  layers: ArtworkLayer[];
}

export type BlendMode = 'normal' | 'multiply' | 'overlay' | 'soft-light';

export type Point = readonly [x: number, y: number];

// ---- mockup-space geometry ---------------------------------------------------------------------
//
// Three concerns, kept apart so none can change the others:
//  - Printable boundary (`AreaPlacement.mask`): which pixels of the PRODUCT PHOTO may show artwork.
//    Authored on the photo, stored as fractions of it, applied after the artwork has been warped.
//  - Surface transformation (`AreaPlacement.surface` / `.mesh`): how the flat artwork is bent onto the
//    photographed object. Only the preview / composite uses it.
//  - Production artwork (`PrintableArea.canvas` + `.shape`): flat, in canvas pixels. Neither of the
//    above ever changes it, so a curved bottle label is still a flat rectangle in the print file.

/** One anchor of a cubic Bezier contour. Positions are fractions of the mockup photograph. */
export interface BezierAnchor {
  x: number;
  y: number;
  /** Absolute position of the control handle before this anchor. Omitted: no handle (a corner). */
  handleIn?: Point;
  /** Absolute position of the control handle after this anchor. Omitted: no handle (a corner). */
  handleOut?: Point;
  /** Editor hint: dragging one handle mirrors the other. Rendering ignores it. */
  smooth?: boolean;
}

/** A closed contour of at least three anchors; consecutive anchors (and last -> first) are joined by one cubic segment. */
export interface BezierContour {
  anchors: BezierAnchor[];
}

/**
 * Editable, versioned cubic Bezier geometry. Several contours may be combined (a hole is a contour
 * inside another one); `fillRule` decides what is inside. Self-intersecting contours are allowed and
 * filled by the rule; the editor warns about them.
 */
export interface BezierPath {
  version: 1;
  fillRule: 'nonzero' | 'evenodd';
  contours: BezierContour[];
}

export const BEZIER_VERSION = 1;

export const BEZIER_LIMITS = {
  maxContours: 16,
  minAnchorsPerContour: 3,
  maxAnchorsPerContour: 256,
  maxAnchors: 1024,
  /** Coordinates may leave the photo a little (handles of an edge anchor often do). */
  minCoordinate: -1,
  maxCoordinate: 2,
} as const;

/**
 * The printable boundary of one placement, in the coordinate space of the mockup photograph.
 *  - `path`: closed Bezier contours.
 *  - `raster`: an alpha-mask image (PNG; its alpha channel is the coverage, so soft edges and
 *    partially transparent pixels are kept) stretched over the whole photo. It is an ordinary image
 *    asset: `src` follows the same rules, storage and cleanup as a mockup image.
 */
export type PlacementMask =
  | { type: 'path'; path: BezierPath }
  | { type: 'raster'; src: string; width: number; height: number };

/**
 * Vertical-cylinder surface (bottle, jar, mug, tube). The artwork wraps around the cylinder,
 * is seen with an orthographic camera and is clipped where the surface turns away from the camera.
 * The placement rectangle bounds the visible part of the artwork. Angles are degrees measured from
 * the meridian that faces the camera (see `util/surface.ts` for the exact mapping).
 */
export interface CylinderSurface {
  type: 'cylinder';
  /** Angle the WHOLE artwork spans around the cylinder: 0 is flat, 360 wraps all the way round. */
  curvature: number;
  /** Where the artwork's centre sits on the cylinder, from the camera-facing meridian. */
  centre: number;
  /** How far left of the camera-facing meridian the surface is still visible (1..90). */
  visibleLeft: number;
  /** How far right of the camera-facing meridian the surface is still visible (1..90). */
  visibleRight: number;
  /** Camera elevation: bows horizontal edges (positive looks down on the object). */
  tilt: number;
}

export const SURFACE_LIMITS = {
  maxCurvature: 360,
  maxCentre: 180,
  minVisible: 1,
  maxVisible: 90,
  maxTilt: 60,
} as const;

/**
 * Editable mesh: a cols x rows grid of control points, smoothly interpolated (Catmull-Rom), that
 * the flat artwork is stretched over. Points are fractions of the PLACEMENT'S OWN FRAME
 * ((0,0) top-left, (1,1) bottom-right of its rectangle or quad), so moving, resizing or
 * rotating the placement carries the mesh along and viewport zoom never matters.
 */
export interface MeshSpec {
  cols: number;
  rows: number;
  /** Row-major `[x0, y0, x1, y1, ...]`: `cols * rows * 2` finite numbers. */
  points: number[];
}

export const MESH_LIMITS = {
  minCells: 2,
  maxCells: 12,
  minCoordinate: -1,
  maxCoordinate: 2,
} as const;

export interface AreaPlacement {
  printableAreaId: string;
  /**
   * `rect`: x/y/width/height (+ rotation) rectangle. `quad`: four normalised corners
   * `[top-left, top-right, bottom-right, bottom-left]` for perspective mapping.
   */
  type: 'rect' | 'quad';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise about the rectangle centre (`rect` only). */
  rotation?: number;
  corners?: readonly [Point, Point, Point, Point];
  blendMode?: BlendMode;
  /** 0..1. Default 1. */
  opacity?: number;
  /** Printable boundary on the photo; the warped artwork is clipped to it. */
  mask?: PlacementMask;
  /** Cylindrical wrap, evaluated inside the placement frame. */
  surface?: CylinderSurface;
  /** Free-form mesh, evaluated inside the placement frame. Overrides `surface` while present. */
  mesh?: MeshSpec;
}

/** True when the placement needs the warp / mask pipeline rather than a plain rectangle or quad. */
export function hasMockupGeometry(placement: AreaPlacement): boolean {
  return !!(placement.mask || placement.surface || placement.mesh);
}

export interface MockupOverlay {
  id: string;
  src: string;
  /** Normalised rectangle; defaults to the whole mockup. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
}

export interface ProductMockup {
  id: string;
  name: string;
  src: string;
  thumbnail?: string;
  /** Hidden mockups are skipped by the storefront. Default true. */
  visible?: boolean;
  placements: AreaPlacement[];
  /** Drawn above the personalized artwork (glass, hands, highlights). */
  overlays?: MockupOverlay[];
}

export interface ProductVariant {
  id: string;
  label: string;
  /** Mockups that show this variant; their order is the preview order. */
  mockupIds: string[];
  /** Printable areas enabled for this variant. */
  printableAreaIds: string[];
  /** Colour chip for the variant picker. */
  swatch?: string;
}

export interface PreviewSettings {
  /** Mockup shown first (must apply to the selected variant to take effect). */
  defaultMockupId?: string;
  /** Preview-only background behind the mockup image (for transparent PNG mockups). */
  background?: string;
}

/**
 * Condition for showing a field. Declarative data only: no expressions are ever evaluated.
 */
export type Condition =
  | { op: 'artwork'; artworkId: string; printableAreaId?: string }
  | { op: 'variant'; variantIds: string[] }
  | { op: 'field-equals'; fieldId: string; value: string | boolean }
  | { op: 'field-filled'; fieldId: string }
  | { op: 'all' | 'any'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };

export interface ProductConfig {
  schemaVersion: typeof PRODUCT_SCHEMA_VERSION;
  /** Stable configuration id. */
  id: string;
  /** Monotonic configuration version; customer drafts are bound to it. */
  version: number;
  status: ConfigStatus;
  product: ProductSpec;
  assetBaseUrl?: string;
  variants: ProductVariant[];
  mockups: ProductMockup[];
  printableAreas: PrintableArea[];
  artworks: Artwork[];
  fonts: FontSpec[];
  /**
   * Customer fields. Each is bound to layers through `layer.fieldId` (never inferred from labels or
   * order). `printableAreaId` / `artworkId` scope a field; omit both to share it across artworks.
   */
  fields: FieldSpec[];
  preview?: PreviewSettings;
  displayPrice?: DisplayPriceSpec;
}

/** What produced a loaded configuration: drives the shape of customization snapshots. */
export type SourceSchemaVersion = 1 | 2;

/** Layers a field feeds, found through the explicit `fieldId` references. */
export function layerFieldId(layer: ArtworkLayer): string | undefined {
  return layer.type === 'fixed-image' || layer.type === 'shape' ? undefined : layer.fieldId;
}

export function isEditableLayer(layer: ArtworkLayer): boolean {
  return layerFieldId(layer) !== undefined;
}

export const DEFAULT_AREA_BOUNDARY: BoundarySpec = {
  visible: true,
  color: '#e11d48',
  opacity: 0.85,
};
