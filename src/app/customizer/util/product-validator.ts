/**
 * Runtime validation of schema-version-2 configurations (supplied by a host, loaded from a URL,
 * imported from a file or produced by the merchant editor). Nothing is trusted: every id, number,
 * colour, URL and path string is checked, cross-references are verified, and success returns a deep
 * copy in which every asset URL is absolute and has passed the URL policy.
 */

import { ConfigIssue, FieldSpec, LIMITS, TextAlign } from '../models/config.models';
import {
  AreaPlacement,
  Artwork,
  ArtworkLayer,
  BlendMode,
  BoundarySpec,
  Condition,
  MockupOverlay,
  PRODUCT_LIMITS,
  PRODUCT_SCHEMA_VERSION,
  Point,
  PrintableArea,
  ProductConfig,
  ProductMockup,
  ProductVariant,
  ShapeSpec,
  layerFieldId,
} from '../models/product.models';
import {
  COLOR_PATTERN,
  Collector,
  Obj,
  SrcResolver,
  validateCanvas,
  validateCondition,
  validateDisplayPrice,
  validateFields,
  validateFonts,
  validatePrint,
  validateProduct,
} from './config-validator';
import { ASPECT_TOLERANCE } from './crop-math';
import { isSafePathData } from './geometry';
import { AssetPolicy, ResolvedBase, checkAssetSrc, resolveAssetDir } from './url-policy';

export type ProductValidationResult =
  { ok: true; config: ProductConfig } | { ok: false; issues: ConfigIssue[] };

export interface ProductValidateOptions {
  resolvedBase: ResolvedBase;
  policy: AssetPolicy;
  /**
   * Editor drafts may still be empty (no mockup, area, artwork or field yet). Structural rules,
   * references and value ranges are still enforced; only the "at least one" minimums are lifted.
   * Published configurations and everything the storefront loads are validated strictly.
   */
  allowIncomplete?: boolean;
}

const MAX_LAYER_EDGE = 16_384;
const BLEND_MODES: readonly BlendMode[] = ['normal', 'multiply', 'overlay', 'soft-light'];

export function validateProductConfig(
  raw: unknown,
  options: ProductValidateOptions,
): ProductValidationResult {
  const c = new Collector();
  const root = c.object(raw, '', [
    'schemaVersion',
    'id',
    'version',
    'status',
    'product',
    'assetBaseUrl',
    'variants',
    'mockups',
    'printableAreas',
    'artworks',
    'fonts',
    'fields',
    'preview',
    'displayPrice',
  ]);
  if (!root) return { ok: false, issues: c.issues };

  if (root['schemaVersion'] !== PRODUCT_SCHEMA_VERSION) {
    c.add(
      'schemaVersion',
      'unsupported-version',
      `unsupported schemaVersion ${JSON.stringify(root['schemaVersion'])}; expected ${PRODUCT_SCHEMA_VERSION}`,
    );
    return { ok: false, issues: c.issues };
  }

  const id = c.id(root['id'], 'id');
  const version = c.number(root['version'], 'version', 1, 1_000_000, true);
  const status = root['status'];
  if (status !== 'draft' && status !== 'published') {
    c.add('status', 'enum', 'must be "draft" or "published"');
  }
  const product = validateProduct(root['product'], c);

  const assetDir = resolveAssetDir(
    root['assetBaseUrl'] === undefined ? undefined : (root['assetBaseUrl'] as string),
    options.resolvedBase,
    options.policy,
  );
  let assetBaseUrl: string | undefined;
  if (assetDir.ok) assetBaseUrl = assetDir.url;
  else c.add('assetBaseUrl', assetDir.code, assetDir.message);

  const resolveSrc: SrcResolver = (value, path) => {
    if (!assetBaseUrl) return null;
    const checked = checkAssetSrc(value, assetBaseUrl, options.policy);
    if (!checked.ok) {
      c.add(path, checked.code, checked.message);
      return null;
    }
    return checked.url;
  };

  const fonts = validateFonts(root['fonts'], resolveSrc, c, PRODUCT_LIMITS.maxFonts);
  const fieldTypes = new Map<string, FieldSpec['type']>();
  const min = options.allowIncomplete ? 0 : 1;
  const fields = validateFields(root['fields'], fonts, resolveSrc, fieldTypes, c, {
    extended: true,
    maxFields: PRODUCT_LIMITS.maxFields,
    maxFonts: PRODUCT_LIMITS.maxFonts,
    maxTextLength: PRODUCT_LIMITS.maxTextLength,
    minFields: min,
  });
  const areas = validateAreas(root['printableAreas'], c, min);
  const fontIds = new Set(fonts.map((f) => f.id));
  const artworks = validateArtworks(root['artworks'], fontIds, resolveSrc, c, min);
  const mockups = validateMockups(root['mockups'], resolveSrc, c, min);
  const variants = validateVariants(root['variants'], c, min);
  const preview = validatePreview(root['preview'], c);
  const displayPrice =
    root['displayPrice'] === undefined ? undefined : validateDisplayPrice(root['displayPrice'], c);

  crossCheck({ fields, areas, artworks, mockups, variants, fonts, preview }, c);

  if (
    c.count > 0 ||
    !id ||
    version === null ||
    !product ||
    (status !== 'draft' && status !== 'published')
  ) {
    return { ok: false, issues: c.issues };
  }
  const config: ProductConfig = {
    schemaVersion: PRODUCT_SCHEMA_VERSION,
    id,
    version,
    status,
    product,
    ...(assetBaseUrl ? { assetBaseUrl } : {}),
    variants,
    mockups,
    printableAreas: areas,
    artworks,
    fonts,
    fields,
    ...(preview ? { preview } : {}),
    ...(displayPrice ? { displayPrice } : {}),
  };
  return { ok: true, config };
}

// ---- shapes -----------------------------------------------------------------------------------

export function validateShape(value: unknown, path: string, c: Collector): ShapeSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    c.add(path, 'type', 'must be an object');
    return null;
  }
  const type = (value as Obj)['type'];
  switch (type) {
    case 'rect': {
      const o = c.object(value, path, ['type', 'cornerRadius']);
      if (!o) return null;
      const radius =
        o['cornerRadius'] === undefined
          ? undefined
          : c.number(o['cornerRadius'], `${path}.cornerRadius`, 0, 0.5);
      return radius === null ? null : { type, ...(radius ? { cornerRadius: radius } : {}) };
    }
    case 'ellipse': {
      const o = c.object(value, path, ['type']);
      return o ? { type } : null;
    }
    case 'path': {
      const o = c.object(value, path, ['type', 'd', 'viewBox']);
      if (!o) return null;
      const d = o['d'];
      if (!isSafePathData(d)) {
        c.add(
          `${path}.d`,
          'path',
          `must be SVG path data (commands, numbers and separators only) of at most ${PRODUCT_LIMITS.maxPathLength} characters`,
        );
      }
      const vb = Array.isArray(o['viewBox']) ? o['viewBox'] : null;
      if (
        !vb ||
        vb.length !== 2 ||
        !vb.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100_000)
      ) {
        c.add(`${path}.viewBox`, 'type', 'must be [width, height] with positive numbers');
        return null;
      }
      return isSafePathData(d) ? { type, d, viewBox: [vb[0], vb[1]] } : null;
    }
    default:
      c.add(`${path}.type`, 'enum', 'must be "rect", "ellipse" or "path"');
      return null;
  }
}

// ---- printable areas ---------------------------------------------------------------------------

function validateAreas(value: unknown, c: Collector, min: number): PrintableArea[] {
  const list = c.array(value, 'printableAreas', min, PRODUCT_LIMITS.maxAreas) ?? [];
  const areas = list.map((item, index): PrintableArea | null => {
    const path = `printableAreas[${index}]`;
    const o = c.object(item, path, [
      'id',
      'name',
      'enabled',
      'canvas',
      'shape',
      'print',
      'artworkId',
      'artworkIds',
      'boundary',
    ]);
    if (!o) return null;
    const id = c.id(o['id'], `${path}.id`);
    const name = c.string(o['name'], `${path}.name`, 1, 80);
    const enabled = o['enabled'] === undefined ? true : c.boolean(o['enabled'], `${path}.enabled`);
    const canvas = validateCanvas(o['canvas'], c, `${path}.canvas`);
    const shape =
      o['shape'] === undefined
        ? ({ type: 'rect' } as ShapeSpec)
        : validateShape(o['shape'], `${path}.shape`, c);
    const print =
      o['print'] === undefined ? undefined : validatePrint(o['print'], canvas, c, `${path}.print`);
    const artworkId = c.id(o['artworkId'], `${path}.artworkId`);
    const ids = (c.array(o['artworkIds'], `${path}.artworkIds`, 1, 12) ?? [])
      .map((entry, i) => c.id(entry, `${path}.artworkIds[${i}]`))
      .filter((entry): entry is string => entry !== null);
    if (new Set(ids).size !== ids.length)
      c.add(`${path}.artworkIds`, 'duplicate-id', 'must not repeat an artwork');
    const boundary =
      o['boundary'] === undefined
        ? undefined
        : validateBoundary(o['boundary'], `${path}.boundary`, c);
    if (!id || !name || enabled === null || !canvas || !shape || !artworkId || boundary === null)
      return null;
    return {
      id,
      name,
      enabled,
      canvas,
      shape,
      ...(print ? { print } : {}),
      artworkId,
      artworkIds: ids,
      ...(boundary ? { boundary } : {}),
    };
  });
  c.requireUnique(
    areas.map((a) => a?.id ?? null),
    'printableAreas',
  );
  return areas.filter((a): a is PrintableArea => a !== null);
}

function validateBoundary(value: unknown, path: string, c: Collector): BoundarySpec | null {
  const o = c.object(value, path, ['visible', 'color', 'opacity']);
  if (!o) return null;
  const visible = c.boolean(o['visible'], `${path}.visible`);
  const color = c.color(o['color'], `${path}.color`);
  const opacity = c.number(o['opacity'], `${path}.opacity`, 0, 1);
  return visible === null || color === null || opacity === null
    ? null
    : { visible, color, opacity };
}

// ---- artworks and layers -------------------------------------------------------------------------

function validateArtworks(
  value: unknown,
  fontIds: ReadonlySet<string>,
  resolveSrc: SrcResolver,
  c: Collector,
  min: number,
): Artwork[] {
  const list = c.array(value, 'artworks', min, PRODUCT_LIMITS.maxArtworks) ?? [];
  const artworks = list.map((item, index): Artwork | null => {
    const path = `artworks[${index}]`;
    const o = c.object(item, path, ['id', 'name', 'printableAreaId', 'background', 'layers']);
    if (!o) return null;
    const id = c.id(o['id'], `${path}.id`);
    const name = c.string(o['name'], `${path}.name`, 1, 80);
    const printableAreaId = c.id(o['printableAreaId'], `${path}.printableAreaId`);
    let background: string | undefined;
    if (o['background'] !== undefined) {
      background =
        o['background'] === 'transparent'
          ? 'transparent'
          : (c.color(o['background'], `${path}.background`) ?? undefined);
    }
    const layerList =
      c.array(o['layers'], `${path}.layers`, 0, PRODUCT_LIMITS.maxLayersPerArtwork) ?? [];
    const layers = layerList
      .map((layer, i) => validateLayer(layer, `${path}.layers[${i}]`, fontIds, resolveSrc, c))
      .filter((layer): layer is ArtworkLayer => layer !== null);
    if (!id || !name || !printableAreaId) return null;
    return { id, name, printableAreaId, ...(background ? { background } : {}), layers };
  });
  c.requireUnique(
    artworks.map((a) => a?.id ?? null),
    'artworks',
  );
  // Layer ids are unique across the configuration, so selection and bindings are unambiguous.
  const seen = new Set<string>();
  artworks.forEach((artwork, ai) =>
    artwork?.layers.forEach((layer, li) => {
      if (seen.has(layer.id))
        c.add(
          `artworks[${ai}].layers[${li}].id`,
          'duplicate-id',
          `duplicate layer id "${layer.id}"`,
        );
      seen.add(layer.id);
    }),
  );
  return artworks.filter((a): a is Artwork => a !== null);
}

const LAYER_COMMON = [
  'id',
  'name',
  'type',
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'opacity',
  'visible',
  'locked',
  'clip',
];

function validateLayer(
  item: unknown,
  path: string,
  fontIds: ReadonlySet<string>,
  resolveSrc: SrcResolver,
  c: Collector,
): ArtworkLayer | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    c.add(path, 'type', 'must be an object');
    return null;
  }
  const type = (item as Obj)['type'];
  const extra: Record<string, string[]> = {
    'fixed-image': ['src', 'fit'],
    'image-placeholder': ['fieldId', 'fit', 'placeholderLabel'],
    text: [
      'fieldId',
      'text',
      'fontId',
      'fontSize',
      'minFontSize',
      'color',
      'bold',
      'italic',
      'underline',
      'align',
      'wrap',
      'lineHeight',
      'verticalAlign',
    ],
    artwork: ['fieldId'],
    shape: ['shape', 'fill', 'stroke', 'strokeWidth'],
  };
  if (typeof type !== 'string' || !(type in extra)) {
    c.add(
      `${path}.type`,
      'unknown-type',
      `unknown layer type ${JSON.stringify(type)}; expected fixed-image, image-placeholder, text, artwork or shape`,
    );
    return null;
  }
  const o = c.object(item, path, [...LAYER_COMMON, ...extra[type]]);
  if (!o) return null;

  const id = c.id(o['id'], `${path}.id`);
  const name = o['name'] === undefined ? undefined : c.string(o['name'], `${path}.name`, 1, 80);
  const x = c.number(o['x'], `${path}.x`, -MAX_LAYER_EDGE, MAX_LAYER_EDGE);
  const y = c.number(o['y'], `${path}.y`, -MAX_LAYER_EDGE, MAX_LAYER_EDGE);
  const width = c.number(o['width'], `${path}.width`, 0, MAX_LAYER_EDGE);
  const height = c.number(o['height'], `${path}.height`, 0, MAX_LAYER_EDGE);
  if (width !== null && height !== null && (width <= 0 || height <= 0)) {
    c.add(path, 'range', 'width and height must be greater than 0');
  }
  const rotation =
    o['rotation'] === undefined
      ? undefined
      : c.number(o['rotation'], `${path}.rotation`, -360, 360);
  const opacity =
    o['opacity'] === undefined ? undefined : c.number(o['opacity'], `${path}.opacity`, 0, 1);
  const visible =
    o['visible'] === undefined ? undefined : c.boolean(o['visible'], `${path}.visible`);
  const locked = o['locked'] === undefined ? undefined : c.boolean(o['locked'], `${path}.locked`);
  let clip: ShapeSpec | null = null;
  let clipOk = true;
  if (o['clip'] !== undefined && o['clip'] !== null) {
    clip = validateShape(o['clip'], `${path}.clip`, c);
    clipOk = clip !== null;
  }

  const common =
    id && x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0
      ? {
          id,
          ...(name ? { name } : {}),
          x,
          y,
          width,
          height,
          ...(rotation ? { rotation } : {}),
          ...(opacity !== undefined && opacity !== null && opacity !== 1 ? { opacity } : {}),
          ...(visible === false ? { visible: false } : {}),
          ...(locked ? { locked: true } : {}),
          ...(clip ? { clip } : {}),
        }
      : null;
  if (
    !common ||
    name === null ||
    rotation === null ||
    opacity === null ||
    visible === null ||
    locked === null ||
    !clipOk
  ) {
    // Still validate the type-specific part so the author sees every problem at once.
    validateLayerSpecific(type, o, path, fontIds, resolveSrc, c);
    return null;
  }

  const specific = validateLayerSpecific(type, o, path, fontIds, resolveSrc, c);
  return specific ? ({ ...common, ...specific } as ArtworkLayer) : null;
}

function validateLayerSpecific(
  type: string,
  o: Obj,
  path: string,
  fontIds: ReadonlySet<string>,
  resolveSrc: SrcResolver,
  c: Collector,
): Record<string, unknown> | null {
  const fit = (allowed: readonly string[]) => {
    if (o['fit'] === undefined) return undefined;
    if (typeof o['fit'] === 'string' && allowed.includes(o['fit'])) return o['fit'];
    c.add(`${path}.fit`, 'enum', `must be one of ${allowed.join(', ')}`);
    return null;
  };
  switch (type) {
    case 'fixed-image': {
      const src = resolveSrc(o['src'], `${path}.src`);
      const f = fit(['contain', 'cover', 'stretch']);
      return src && f !== null ? { type, src, ...(f ? { fit: f } : {}) } : null;
    }
    case 'image-placeholder': {
      const fieldId = c.id(o['fieldId'], `${path}.fieldId`);
      const f = fit(['contain', 'cover']);
      const label =
        o['placeholderLabel'] === undefined
          ? undefined
          : c.string(o['placeholderLabel'], `${path}.placeholderLabel`, 1, 60);
      return fieldId && f !== null && label !== null
        ? { type, fieldId, ...(f ? { fit: f } : {}), ...(label ? { placeholderLabel: label } : {}) }
        : null;
    }
    case 'artwork': {
      const fieldId = c.id(o['fieldId'], `${path}.fieldId`);
      return fieldId ? { type, fieldId } : null;
    }
    case 'shape': {
      const shape = validateShape(o['shape'], `${path}.shape`, c);
      const fill = validateFill(o['fill'], `${path}.fill`, c);
      const stroke =
        o['stroke'] === undefined ? undefined : validateFill(o['stroke'], `${path}.stroke`, c);
      const strokeWidth =
        o['strokeWidth'] === undefined
          ? undefined
          : c.number(o['strokeWidth'], `${path}.strokeWidth`, 0, 1000);
      if (!shape || fill === null || stroke === null || strokeWidth === null) return null;
      return {
        type,
        shape,
        fill,
        ...(stroke ? { stroke } : {}),
        ...(strokeWidth ? { strokeWidth } : {}),
      };
    }
    case 'text': {
      const fieldId =
        o['fieldId'] === undefined ? undefined : c.id(o['fieldId'], `${path}.fieldId`);
      const text =
        o['text'] === undefined ? undefined : c.string(o['text'], `${path}.text`, 0, 500);
      if (fieldId === undefined && text === undefined) {
        c.add(
          path,
          'type',
          'a text layer needs either "fieldId" (customer text) or "text" (fixed text)',
        );
      }
      const fontId = o['fontId'] === undefined ? undefined : c.id(o['fontId'], `${path}.fontId`);
      if (fontId && !fontIds.has(fontId)) {
        c.add(`${path}.fontId`, 'unknown-reference', `font "${fontId}" is not declared in "fonts"`);
      }
      const fontSize = c.number(o['fontSize'], `${path}.fontSize`, 1, LIMITS.maxOutputEdge);
      const minFontSize = c.number(
        o['minFontSize'],
        `${path}.minFontSize`,
        1,
        LIMITS.maxOutputEdge,
      );
      if (fontSize !== null && minFontSize !== null && minFontSize > fontSize) {
        c.add(`${path}.minFontSize`, 'range', 'must not exceed fontSize');
      }
      const color = o['color'] === undefined ? undefined : c.color(o['color'], `${path}.color`);
      const flags: Record<string, boolean> = {};
      for (const key of ['bold', 'italic', 'underline', 'wrap'] as const) {
        if (o[key] === undefined) continue;
        const flag = c.boolean(o[key], `${path}.${key}`);
        if (flag !== null) flags[key] = flag;
      }
      const align = o['align'];
      if (align !== 'left' && align !== 'center' && align !== 'right')
        c.add(`${path}.align`, 'enum', 'must be "left", "center" or "right"');
      const lineHeight =
        o['lineHeight'] === undefined
          ? undefined
          : c.number(o['lineHeight'], `${path}.lineHeight`, 0.5, 4);
      const va = o['verticalAlign'];
      if (va !== undefined && va !== 'top' && va !== 'middle' && va !== 'bottom')
        c.add(`${path}.verticalAlign`, 'enum', 'must be "top", "middle" or "bottom"');
      if (
        fontSize === null ||
        minFontSize === null ||
        (align !== 'left' && align !== 'center' && align !== 'right') ||
        fieldId === null ||
        text === null ||
        fontId === null ||
        color === null ||
        lineHeight === null ||
        (fieldId === undefined && text === undefined) ||
        (va !== undefined && va !== 'top' && va !== 'middle' && va !== 'bottom')
      )
        return null;
      return {
        type,
        ...(fieldId ? { fieldId } : {}),
        ...(fieldId === undefined && text !== undefined ? { text } : {}),
        ...(fontId ? { fontId } : {}),
        fontSize,
        minFontSize,
        ...(color ? { color } : {}),
        ...flags,
        align: align as TextAlign,
        ...(lineHeight ? { lineHeight } : {}),
        ...(va ? { verticalAlign: va } : {}),
      };
    }
  }
  return null;
}

function validateFill(value: unknown, path: string, c: Collector): string | null {
  if (value === 'transparent') return 'transparent';
  if (typeof value === 'string' && COLOR_PATTERN.test(value)) return value;
  c.add(path, 'color', 'must be "transparent" or a hex colour such as #296FD7');
  return null;
}

// ---- mockups ----------------------------------------------------------------------------------

function validateMockups(
  value: unknown,
  resolveSrc: SrcResolver,
  c: Collector,
  min: number,
): ProductMockup[] {
  const list = c.array(value, 'mockups', min, PRODUCT_LIMITS.maxMockups) ?? [];
  const mockups = list.map((item, index): ProductMockup | null => {
    const path = `mockups[${index}]`;
    const o = c.object(item, path, [
      'id',
      'name',
      'src',
      'thumbnail',
      'visible',
      'placements',
      'overlays',
    ]);
    if (!o) return null;
    const id = c.id(o['id'], `${path}.id`);
    const name = c.string(o['name'], `${path}.name`, 1, 80);
    const src = resolveSrc(o['src'], `${path}.src`);
    const thumbnail =
      o['thumbnail'] === undefined ? undefined : resolveSrc(o['thumbnail'], `${path}.thumbnail`);
    const visible =
      o['visible'] === undefined ? undefined : c.boolean(o['visible'], `${path}.visible`);
    const placements = (
      c.array(o['placements'], `${path}.placements`, 0, PRODUCT_LIMITS.maxAreas) ?? []
    )
      .map((p, i) => validatePlacement(p, `${path}.placements[${i}]`, c))
      .filter((p): p is AreaPlacement => p !== null);
    const overlays =
      o['overlays'] === undefined
        ? undefined
        : (c.array(o['overlays'], `${path}.overlays`, 0, PRODUCT_LIMITS.maxOverlaysPerMockup) ?? [])
            .map((entry, i) => validateOverlay(entry, `${path}.overlays[${i}]`, resolveSrc, c))
            .filter((entry): entry is MockupOverlay => entry !== null);
    if (!id || !name || !src || thumbnail === null || visible === null) return null;
    return {
      id,
      name,
      src,
      ...(thumbnail ? { thumbnail } : {}),
      ...(visible === false ? { visible: false } : {}),
      placements,
      ...(overlays?.length ? { overlays } : {}),
    };
  });
  c.requireUnique(
    mockups.map((m) => m?.id ?? null),
    'mockups',
  );
  return mockups.filter((m): m is ProductMockup => m !== null);
}

function validateOverlay(
  value: unknown,
  path: string,
  resolveSrc: SrcResolver,
  c: Collector,
): MockupOverlay | null {
  const o = c.object(value, path, ['id', 'src', 'x', 'y', 'width', 'height', 'opacity']);
  if (!o) return null;
  const id = c.id(o['id'], `${path}.id`);
  const src = resolveSrc(o['src'], `${path}.src`);
  const out: Record<string, number> = {};
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (o[key] === undefined) continue;
    const n = c.number(o[key], `${path}.${key}`, -1, 2);
    if (n !== null) out[key] = n;
  }
  const opacity =
    o['opacity'] === undefined ? undefined : c.number(o['opacity'], `${path}.opacity`, 0, 1);
  return id && src && opacity !== null
    ? { id, src, ...out, ...(opacity !== undefined ? { opacity } : {}) }
    : null;
}

function validatePlacement(value: unknown, path: string, c: Collector): AreaPlacement | null {
  const o = c.object(value, path, [
    'printableAreaId',
    'type',
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'corners',
    'blendMode',
    'opacity',
  ]);
  if (!o) return null;
  const printableAreaId = c.id(o['printableAreaId'], `${path}.printableAreaId`);
  const type = o['type'];
  if (type !== 'rect' && type !== 'quad') c.add(`${path}.type`, 'enum', 'must be "rect" or "quad"');
  const x = c.number(o['x'], `${path}.x`, -1, 2);
  const y = c.number(o['y'], `${path}.y`, -1, 2);
  const width = c.number(o['width'], `${path}.width`, 0, 3);
  const height = c.number(o['height'], `${path}.height`, 0, 3);
  if (width !== null && height !== null && (width <= 0 || height <= 0))
    c.add(path, 'range', 'width and height must be greater than 0');
  const rotation =
    o['rotation'] === undefined
      ? undefined
      : c.number(o['rotation'], `${path}.rotation`, -360, 360);
  let corners: [Point, Point, Point, Point] | undefined;
  if (type === 'quad') {
    const raw = Array.isArray(o['corners']) ? o['corners'] : null;
    const ok =
      raw &&
      raw.length === 4 &&
      raw.every(
        (p) =>
          Array.isArray(p) &&
          p.length === 2 &&
          p.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= -1 && n <= 2),
      );
    if (!ok)
      c.add(
        `${path}.corners`,
        'type',
        'a quad placement needs four [x, y] corners (top-left, top-right, bottom-right, bottom-left)',
      );
    else corners = raw.map((p) => [p[0], p[1]] as Point) as [Point, Point, Point, Point];
  }
  const blendMode = o['blendMode'];
  if (blendMode !== undefined && !BLEND_MODES.includes(blendMode as BlendMode))
    c.add(`${path}.blendMode`, 'enum', `must be one of ${BLEND_MODES.join(', ')}`);
  const opacity =
    o['opacity'] === undefined ? undefined : c.number(o['opacity'], `${path}.opacity`, 0, 1);
  if (
    !printableAreaId ||
    (type !== 'rect' && type !== 'quad') ||
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width <= 0 ||
    height <= 0 ||
    rotation === null ||
    opacity === null ||
    (type === 'quad' && !corners) ||
    (blendMode !== undefined && !BLEND_MODES.includes(blendMode as BlendMode))
  )
    return null;
  return {
    printableAreaId,
    type,
    x,
    y,
    width,
    height,
    ...(rotation ? { rotation } : {}),
    ...(corners ? { corners } : {}),
    ...(blendMode && blendMode !== 'normal' ? { blendMode: blendMode as BlendMode } : {}),
    ...(opacity !== undefined && opacity !== 1 ? { opacity } : {}),
  };
}

// ---- variants, preview ----------------------------------------------------------------------------

function validateVariants(value: unknown, c: Collector, listMin: number): ProductVariant[] {
  const list = c.array(value, 'variants', 1, PRODUCT_LIMITS.maxVariants) ?? [];
  const variants = list.map((item, index): ProductVariant | null => {
    const path = `variants[${index}]`;
    const o = c.object(item, path, ['id', 'label', 'mockupIds', 'printableAreaIds', 'swatch']);
    if (!o) return null;
    const id = c.id(o['id'], `${path}.id`);
    const label = c.string(o['label'], `${path}.label`, 1, 60);
    const ids = (key: 'mockupIds' | 'printableAreaIds') => {
      const out = (c.array(o[key], `${path}.${key}`, listMin, 40) ?? [])
        .map((entry, i) => c.id(entry, `${path}.${key}[${i}]`))
        .filter((entry): entry is string => entry !== null);
      if (new Set(out).size !== out.length)
        c.add(`${path}.${key}`, 'duplicate-id', 'must not repeat an id');
      return out;
    };
    const mockupIds = ids('mockupIds');
    const printableAreaIds = ids('printableAreaIds');
    const swatch = o['swatch'] === undefined ? undefined : c.color(o['swatch'], `${path}.swatch`);
    if (!id || !label || swatch === null) return null;
    return { id, label, mockupIds, printableAreaIds, ...(swatch ? { swatch } : {}) };
  });
  c.requireUnique(
    variants.map((v) => v?.id ?? null),
    'variants',
  );
  return variants.filter((v): v is ProductVariant => v !== null);
}

function validatePreview(value: unknown, c: Collector): ProductConfig['preview'] {
  if (value === undefined) return undefined;
  const o = c.object(value, 'preview', ['defaultMockupId', 'background']);
  if (!o) return undefined;
  const defaultMockupId =
    o['defaultMockupId'] === undefined
      ? undefined
      : c.id(o['defaultMockupId'], 'preview.defaultMockupId');
  const background =
    o['background'] === undefined ? undefined : c.color(o['background'], 'preview.background');
  if (defaultMockupId === null || background === null) return undefined;
  return {
    ...(defaultMockupId ? { defaultMockupId } : {}),
    ...(background ? { background } : {}),
  };
}

// ---- cross references -------------------------------------------------------------------------------

interface Parts {
  fields: FieldSpec[];
  areas: PrintableArea[];
  artworks: Artwork[];
  mockups: ProductMockup[];
  variants: ProductVariant[];
  fonts: { id: string }[];
  preview: ProductConfig['preview'];
}

function crossCheck(p: Parts, c: Collector): void {
  const areaById = new Map(p.areas.map((a) => [a.id, a]));
  const artworkById = new Map(p.artworks.map((a) => [a.id, a]));
  const fieldById = new Map(p.fields.map((f) => [f.id, f]));
  const mockupIds = new Set(p.mockups.map((m) => m.id));
  const variantIds = new Set(p.variants.map((v) => v.id));

  p.areas.forEach((area, ai) => {
    const path = `printableAreas[${ai}]`;
    if (!area.artworkIds.includes(area.artworkId))
      c.add(`${path}.artworkIds`, 'unknown-reference', "must include the area's default artworkId");
    for (const id of new Set([area.artworkId, ...area.artworkIds])) {
      const artwork = artworkById.get(id);
      if (!artwork)
        c.add(
          `${path}.artworkIds`,
          'unknown-reference',
          `artwork "${id}" is not declared in "artworks"`,
        );
      else if (artwork.printableAreaId !== area.id)
        c.add(
          `${path}.artworkIds`,
          'wrong-area',
          `artwork "${id}" belongs to area "${artwork.printableAreaId}"`,
        );
    }
  });

  const referenced = new Map<string, { areaIds: Set<string>; artworkIds: Set<string> }>();
  p.artworks.forEach((artwork, ai) => {
    if (!areaById.has(artwork.printableAreaId))
      c.add(
        `artworks[${ai}].printableAreaId`,
        'unknown-reference',
        `area "${artwork.printableAreaId}" is not declared in "printableAreas"`,
      );
    artwork.layers.forEach((layer, li) => {
      const path = `artworks[${ai}].layers[${li}]`;
      const fieldId = layerFieldId(layer);
      if (fieldId === undefined) return;
      const field = fieldById.get(fieldId);
      if (!field) {
        c.add(
          `${path}.fieldId`,
          'unknown-reference',
          `field "${fieldId}" is not declared in "fields"`,
        );
        return;
      }
      const expected =
        layer.type === 'image-placeholder'
          ? 'image'
          : layer.type === 'artwork'
            ? 'artwork'
            : 'text';
      if (field.type !== expected)
        c.add(
          `${path}.fieldId`,
          'type-mismatch',
          `a ${layer.type} layer needs a ${expected} field, but "${fieldId}" is a ${field.type} field`,
        );
      const entry = referenced.get(fieldId) ?? {
        areaIds: new Set<string>(),
        artworkIds: new Set<string>(),
      };
      entry.areaIds.add(artwork.printableAreaId);
      entry.artworkIds.add(artwork.id);
      referenced.set(fieldId, entry);
      if (field.artworkId && field.artworkId !== artwork.id)
        c.add(
          `${path}.fieldId`,
          'scope-mismatch',
          `field "${fieldId}" is scoped to artwork "${field.artworkId}" but used in "${artwork.id}"`,
        );
      if (field.printableAreaId && field.printableAreaId !== artwork.printableAreaId)
        c.add(
          `${path}.fieldId`,
          'scope-mismatch',
          `field "${fieldId}" is scoped to area "${field.printableAreaId}" but used in "${artwork.printableAreaId}"`,
        );
    });
  });

  p.fields.forEach((field, fi) => {
    const path = `fields[${fi}]`;
    if (!referenced.has(field.id))
      c.add(
        path,
        'field-without-layer',
        `field "${field.id}" is not bound to any layer, so it would have no effect`,
      );
    if (field.printableAreaId && !areaById.has(field.printableAreaId))
      c.add(
        `${path}.printableAreaId`,
        'unknown-reference',
        `area "${field.printableAreaId}" is not declared`,
      );
    if (field.artworkId) {
      const artwork = artworkById.get(field.artworkId);
      if (!artwork)
        c.add(
          `${path}.artworkId`,
          'unknown-reference',
          `artwork "${field.artworkId}" is not declared`,
        );
      else if (field.printableAreaId && artwork.printableAreaId !== field.printableAreaId)
        c.add(
          `${path}.artworkId`,
          'scope-mismatch',
          "the artwork does not belong to the field's printable area",
        );
    }
    if (field.showWhen) checkCondition(field.showWhen, `${path}.showWhen`, field.id);
    if (field.type === 'text') {
      for (const key of ['fontIds'] as const)
        for (const id of field[key])
          if (!p.fonts.some((f) => f.id === id))
            c.add(`${path}.${key}`, 'unknown-reference', `font "${id}" is not declared`);
    }
  });

  function checkCondition(condition: Condition, path: string, ownerId: string): void {
    switch (condition.op) {
      case 'artwork':
        if (!artworkById.has(condition.artworkId))
          c.add(path, 'unknown-reference', `artwork "${condition.artworkId}" is not declared`);
        if (condition.printableAreaId && !areaById.has(condition.printableAreaId))
          c.add(path, 'unknown-reference', `area "${condition.printableAreaId}" is not declared`);
        break;
      case 'variant':
        for (const id of condition.variantIds)
          if (!variantIds.has(id))
            c.add(path, 'unknown-reference', `variant "${id}" is not declared`);
        break;
      case 'field-equals':
      case 'field-filled':
        if (!fieldById.has(condition.fieldId))
          c.add(path, 'unknown-reference', `field "${condition.fieldId}" is not declared`);
        else if (condition.fieldId === ownerId)
          c.add(path, 'self-reference', 'a field cannot depend on itself');
        break;
      case 'all':
      case 'any':
        condition.conditions.forEach((inner, i) =>
          checkCondition(inner, `${path}.conditions[${i}]`, ownerId),
        );
        break;
      case 'not':
        checkCondition(condition.condition, `${path}.condition`, ownerId);
        break;
    }
  }

  p.mockups.forEach((mockup, mi) =>
    mockup.placements.forEach((placement, pi) => {
      const path = `mockups[${mi}].placements[${pi}]`;
      if (!areaById.has(placement.printableAreaId))
        c.add(
          `${path}.printableAreaId`,
          'unknown-reference',
          `area "${placement.printableAreaId}" is not declared`,
        );
    }),
  );
  p.mockups.forEach((mockup, mi) => {
    const seen = new Set<string>();
    mockup.placements.forEach((placement, pi) => {
      if (seen.has(placement.printableAreaId))
        c.add(
          `mockups[${mi}].placements[${pi}].printableAreaId`,
          'duplicate-id',
          `area "${placement.printableAreaId}" is placed twice on this mockup`,
        );
      seen.add(placement.printableAreaId);
    });
  });

  p.variants.forEach((variant, vi) => {
    const path = `variants[${vi}]`;
    for (const id of variant.mockupIds)
      if (!mockupIds.has(id))
        c.add(
          `${path}.mockupIds`,
          'unknown-reference',
          `mockup "${id}" is not declared in "mockups"`,
        );
    for (const id of variant.printableAreaIds)
      if (!areaById.has(id))
        c.add(
          `${path}.printableAreaIds`,
          'unknown-reference',
          `area "${id}" is not declared in "printableAreas"`,
        );
  });
  if (p.preview?.defaultMockupId && !mockupIds.has(p.preview.defaultMockupId))
    c.add(
      'preview.defaultMockupId',
      'unknown-reference',
      `mockup "${p.preview.defaultMockupId}" is not declared`,
    );
}

/** Aspect-ratio drift between a rectangular placement and its area; advisory (editor warning). */
export function placementAspectError(
  placement: AreaPlacement,
  area: PrintableArea,
  mockupWidth: number,
  mockupHeight: number,
): number {
  const placementAspect = (placement.width * mockupWidth) / (placement.height * mockupHeight);
  const canvasAspect = area.canvas.width / area.canvas.height;
  const drift = Math.abs(placementAspect - canvasAspect) / canvasAspect;
  return drift > ASPECT_TOLERANCE ? drift : 0;
}
