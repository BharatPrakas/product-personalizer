/**
 * The canonical scene. `evaluateProduct` turns (configuration + resolved variant + draft values +
 * loaded assets) into one independent `AreaScene` per active printable area, plus every per-field
 * validation result. The storefront preview, the merchant editor, the production PNGs and the
 * combined preview PNGs all draw these same scenes, so they cannot drift apart.
 *
 * Operations are expressed in the area's own canvas pixels. Customer-facing placeholders (the
 * dashed "Photo 1" slots) are flagged `previewOnly` and never reach production exports.
 */

import {
  ArtworkFieldSpec,
  ImageFieldSpec,
  LIMITS,
  PrintSpec,
  TextAlign,
  TextFieldSpec,
} from '../models/config.models';
import { CropRect, FieldError, QuarterTurns } from '../models/draft.models';
import type {
  ImagePlaceholderLayer,
  PrintableArea,
  ProductConfig,
  ShapeSpec,
  TextLayer,
} from '../models/product.models';
import { checkCrop, cropToPixels, defaultCrop, effectiveDpi } from './crop-math';
import { Box } from './geometry';
import { ActiveField, ResolvedArea, ResolvedProduct, activeFields } from './resolve';
import { LayoutLine, TextMeasurer, TextStyle, layoutText } from './text-layout';
import {
  hasVisibleContent,
  normalizeText,
  probeableCharacters,
  structuralTextProblems,
} from './text-utils';
import { DraftValues, isArtworkValue, isImageValue, isTextValue } from './values';

export interface LocalAsset {
  assetId: string;
  /** Canonical re-encoded image (PNG for PNG input, JPEG for JPEG input), without metadata. */
  blob: Blob;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

interface OpBase {
  layerId: string;
  /** The layer box in canvas pixels; rotation and clipping are relative to it. */
  box: Box;
  /** Degrees clockwise about the box centre. */
  rotation: number;
  opacity: number;
  clip: ShapeSpec | null;
  /** Drawn in on-screen previews only; omitted from production exports. */
  previewOnly?: boolean;
}

export interface ImageOp extends OpBase {
  kind: 'image';
  source: ImageBitmap;
  /** Clockwise quarter turns applied to the source before cropping. */
  turns: 0 | 1 | 2 | 3;
  /** Source rectangle in the turned image, in pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rectangle in canvas pixels (before the layer rotation). */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface TextOp extends OpBase {
  kind: 'text';
  /** Canvas font shorthand, e.g. `bold 48px "zb-1a2b-CustomizerSans"`. */
  font: string;
  fontSize: number;
  color: string;
  align: TextAlign;
  underline: boolean;
  /** Lines in canvas pixels: anchor x for `align` and alphabetic baseline y. */
  lines: LayoutLine[];
}

export interface ShapeOp extends OpBase {
  kind: 'shape';
  shape: ShapeSpec;
  fill: string;
  stroke: string | null;
  strokeWidth: number;
}

export interface PlaceholderOp extends OpBase {
  kind: 'placeholder';
  label: string;
  previewOnly: true;
}

export type SceneOp = ImageOp | TextOp | ShapeOp | PlaceholderOp;

export interface AreaScene {
  areaId: string;
  areaName: string;
  artworkId: string | null;
  /** The area's own production canvas. */
  width: number;
  height: number;
  /** `transparent` or a hex colour. */
  background: string;
  /** Production mask: everything outside it is transparent in the exported artwork. */
  shape: ShapeSpec;
  ops: SceneOp[];
}

export type ResolutionLevel = 'ok' | 'warn' | 'block';

export interface ImageResolution {
  dpi: number;
  level: ResolutionLevel;
}

export interface Evaluation {
  /** One independent scene per active printable area, in configuration order. */
  areas: AreaScene[];
  /** Blocking problems of active fields, in field order. */
  errors: FieldError[];
  /** Non-blocking notes per field (e.g. low resolution). */
  warnings: Record<string, string[]>;
  /** Chosen font size per text field. */
  textFit: Record<string, { fontSize: number; fits: boolean }>;
  /** Effective DPI per photo field (worst case when a field feeds several slots). */
  resolution: Record<string, ImageResolution>;
}

export interface EvaluationEnv {
  config: ProductConfig;
  /** Config font id -> registered canvas family. */
  fontFamilies: ReadonlyMap<string, string>;
  /** Decoded mockup, overlay, artwork and fixed images by absolute URL. */
  staticImages: ReadonlyMap<string, ImageBitmap>;
  localAssets: ReadonlyMap<string, LocalAsset>;
  measurer: TextMeasurer;
  /** Returns the characters of `chars` the font cannot draw. */
  missingGlyphs: (family: string, chars: string[]) => string[];
}

export interface EvaluationOptions {
  /** Add preview-only placeholder operations for empty customer slots. */
  placeholders: boolean;
}

export function dpiThresholds(print: PrintSpec): { warn: number; min: number | null } {
  return {
    warn: Math.max(LIMITS.warnDpiFloor, print.warnDpi ?? 0),
    min: print.minDpi === undefined ? null : Math.max(LIMITS.minDpiFloor, print.minDpi),
  };
}

export function evaluateProduct(
  env: EvaluationEnv,
  resolved: ResolvedProduct,
  values: DraftValues,
  options: EvaluationOptions,
): Evaluation {
  const { config } = env;
  const active = activeFields(config, resolved, values);
  const activeById = new Map(active.map((entry) => [entry.field.id, entry]));
  const fieldOrder = new Map(config.fields.map((f, i) => [f.id, i]));

  const state: EvalState = {
    errors: [],
    seen: new Set(),
    warnings: {},
    textFit: {},
    resolution: {},
  };
  const areas = resolved.areas.map((entry) =>
    evaluateArea(env, entry, activeById, values, options, state),
  );
  state.errors.sort((a, b) => (fieldOrder.get(a.fieldId) ?? 0) - (fieldOrder.get(b.fieldId) ?? 0));
  return {
    areas,
    errors: state.errors,
    warnings: state.warnings,
    textFit: state.textFit,
    resolution: state.resolution,
  };
}

interface EvalState {
  errors: FieldError[];
  seen: Set<string>;
  warnings: Record<string, string[]>;
  textFit: Evaluation['textFit'];
  resolution: Evaluation['resolution'];
}

function addError(state: EvalState, error: FieldError): void {
  const key = `${error.fieldId}\u0000${error.code}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  state.errors.push(error);
}

function evaluateArea(
  env: EvaluationEnv,
  entry: ResolvedArea,
  activeById: ReadonlyMap<string, ActiveField>,
  values: DraftValues,
  options: EvaluationOptions,
  state: EvalState,
): AreaScene {
  const { area, artwork, layers } = entry;
  const ops: SceneOp[] = [];
  const fields = new Map(env.config.fields.map((f) => [f.id, f]));

  for (const layer of layers) {
    const common = {
      layerId: layer.id,
      box: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
      rotation: layer.rotation ?? 0,
      opacity: layer.opacity ?? 1,
      clip: layer.clip ?? null,
    };
    switch (layer.type) {
      case 'fixed-image': {
        const bitmap = env.staticImages.get(layer.src);
        if (bitmap) ops.push(fixedImageOp(common, bitmap, layer.fit ?? 'contain'));
        break;
      }
      case 'shape':
        ops.push({
          ...common,
          kind: 'shape',
          shape: layer.shape,
          fill: layer.fill,
          stroke: layer.stroke ?? null,
          strokeWidth: layer.strokeWidth ?? 0,
        });
        break;
      case 'image-placeholder':
      case 'text':
      case 'artwork': {
        const fieldId = layer.fieldId;
        if (layer.type === 'text' && fieldId === undefined) {
          const op = fixedTextOp(env, common, layer);
          if (op) ops.push(op);
          break;
        }
        const entryActive = fieldId === undefined ? undefined : activeById.get(fieldId);
        const field = fieldId === undefined ? undefined : fields.get(fieldId);
        const value = fieldId === undefined ? undefined : values[fieldId];
        if (!entryActive || !field || !value) break;
        const shown = entryActive.shown;
        if (layer.type === 'text' && field.type === 'text' && isTextValue(value)) {
          const op = editableTextOp(env, common, layer, field, value, shown, options, state);
          if (op) ops.push(op);
        } else if (
          layer.type === 'image-placeholder' &&
          field.type === 'image' &&
          isImageValue(value)
        ) {
          const op = imagePlaceholderOp(
            env,
            common,
            layer,
            field,
            value,
            area,
            shown,
            options,
            state,
          );
          if (op) ops.push(op);
        } else if (layer.type === 'artwork' && field.type === 'artwork' && isArtworkValue(value)) {
          const op = artworkChoiceOp(env, common, field, value, shown, state);
          if (op) ops.push(op);
        }
        break;
      }
    }
  }

  return {
    areaId: area.id,
    areaName: area.name,
    artworkId: artwork?.id ?? null,
    width: area.canvas.width,
    height: area.canvas.height,
    background: artwork?.background ?? area.canvas.background,
    shape: area.shape,
    ops,
  };
}

type Common = Pick<ImageOp, 'layerId' | 'box' | 'rotation' | 'opacity' | 'clip'>;

function fixedImageOp(
  common: Common,
  bitmap: ImageBitmap,
  fit: 'contain' | 'cover' | 'stretch',
): ImageOp {
  const { box } = common;
  if (fit === 'stretch') {
    return {
      ...common,
      kind: 'image',
      source: bitmap,
      turns: 0,
      sx: 0,
      sy: 0,
      sw: bitmap.width,
      sh: bitmap.height,
      dx: box.x,
      dy: box.y,
      dw: box.width,
      dh: box.height,
    };
  }
  if (fit === 'cover') {
    const crop = defaultCrop(bitmap.width, bitmap.height, box.width / box.height);
    const { sx, sy, sw, sh } = cropToPixels(crop, bitmap.width, bitmap.height);
    return {
      ...common,
      kind: 'image',
      source: bitmap,
      turns: 0,
      sx,
      sy,
      sw,
      sh,
      dx: box.x,
      dy: box.y,
      dw: box.width,
      dh: box.height,
    };
  }
  return containOp(common, bitmap, 0);
}

function turnedSize(bitmap: ImageBitmap, turns: 0 | 1 | 2 | 3): { w: number; h: number } {
  return turns % 2 === 1
    ? { w: bitmap.height, h: bitmap.width }
    : { w: bitmap.width, h: bitmap.height };
}

function containOp(common: Common, bitmap: ImageBitmap, turns: 0 | 1 | 2 | 3): ImageOp {
  const { box } = common;
  const size = turnedSize(bitmap, turns);
  const scale = Math.min(box.width / size.w, box.height / size.h);
  const dw = size.w * scale;
  const dh = size.h * scale;
  return {
    ...common,
    kind: 'image',
    source: bitmap,
    turns,
    sx: 0,
    sy: 0,
    sw: size.w,
    sh: size.h,
    dx: box.x + (box.width - dw) / 2,
    dy: box.y + (box.height - dh) / 2,
    dw,
    dh,
  };
}

function placeholderOp(common: Common, label: string): PlaceholderOp {
  return { ...common, kind: 'placeholder', label, previewOnly: true };
}

// ---- text ---------------------------------------------------------------------------------------

function textStyleFor(family: string, layer: TextLayer, value?: Partial<TextLayer>): TextStyle {
  return {
    family,
    bold: value?.bold ?? layer.bold ?? false,
    italic: value?.italic ?? layer.italic ?? false,
  };
}

function toTextOp(
  common: Common,
  layer: TextLayer,
  text: string,
  family: string,
  color: string,
  style: { bold?: boolean; italic?: boolean; underline?: boolean; align?: TextAlign },
  env: EvaluationEnv,
): { op: TextOp; fits: boolean; fontSize: number } {
  const align = style.align ?? layer.align;
  const layout = layoutText(
    {
      text,
      box: { width: layer.width, height: layer.height },
      maxSize: layer.fontSize,
      minSize: layer.minFontSize,
      align,
      wrap: layer.wrap ?? false,
      lineHeight: layer.lineHeight ?? 1.2,
      verticalAlign: layer.verticalAlign ?? 'middle',
      style: textStyleFor(family, layer, style),
    },
    env.measurer,
  );
  const op: TextOp = {
    ...common,
    kind: 'text',
    font: layout.font,
    fontSize: layout.fontSize,
    color,
    align,
    underline: style.underline ?? layer.underline ?? false,
    lines: layout.lines.map((line) => ({
      ...line,
      x: line.x + layer.x,
      y: line.y + layer.y,
    })),
  };
  return { op, fits: layout.fits, fontSize: layout.fontSize };
}

function fixedTextOp(env: EvaluationEnv, common: Common, layer: TextLayer): TextOp | null {
  const text = normalizeText(layer.text ?? '');
  if (!hasVisibleContent(text)) return null;
  const fontId = layer.fontId ?? env.config.fonts[0]?.id;
  const family = fontId ? env.fontFamilies.get(fontId) : undefined;
  if (!family) return null;
  return toTextOp(common, layer, text, family, layer.color ?? '#111827', {}, env).op;
}

function editableTextOp(
  env: EvaluationEnv,
  common: Common,
  layer: TextLayer,
  field: TextFieldSpec,
  value: {
    text: string;
    fontId: string;
    color: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    align?: TextAlign;
  },
  shown: boolean,
  options: EvaluationOptions,
  state: EvalState,
): TextOp | PlaceholderOp | null {
  const text = normalizeText(value.text);
  // Spaces, zero-width characters and lone combining marks draw nothing, so they count as empty.
  if (!hasVisibleContent(text)) {
    if (field.required && shown)
      addError(state, {
        fieldId: field.id,
        code: 'required',
        message: `${field.label} is required.`,
      });
    return options.placeholders ? placeholderOp(common, field.placeholder ?? field.label) : null;
  }
  const family = env.fontFamilies.get(value.fontId);
  if (!family || !field.fontIds.includes(value.fontId) || !field.colors.includes(value.color)) {
    addError(state, {
      fieldId: field.id,
      code: 'invalid-option',
      message: 'Choose one of the available fonts and colours.',
    });
    return null;
  }

  const structural = structuralTextProblems(text, field.maxLength);
  for (const problem of structural) {
    addError(state, { fieldId: field.id, code: problem.code, message: problem.message });
  }
  // Save is blocked anyway while a structural problem exists, so don't spend a glyph probe per new
  // character on (say) a pasted novel. Over-limit text is still previewed unless it is absurdly long.
  if (structural.some((p) => p.code === 'too-long') && text.length > field.maxLength * 8)
    return null;
  const missing =
    structural.length === 0 ? env.missingGlyphs(family, probeableCharacters(text)) : [];
  if (missing.length > 0) {
    const shownChars = missing.slice(0, 5).join(' ');
    addError(state, {
      fieldId: field.id,
      code: 'unsupported-glyph',
      message: `The selected font can't print: ${shownChars}${missing.length > 5 ? ' …' : ''}. Remove those characters or choose another font.`,
    });
  }

  const controls = new Set(field.styleControls ?? []);
  const { op, fits, fontSize } = toTextOp(
    common,
    layer,
    text,
    family,
    value.color,
    {
      bold: controls.has('bold') ? value.bold : undefined,
      italic: controls.has('italic') ? value.italic : undefined,
      underline: controls.has('underline') ? value.underline : undefined,
      align: controls.has('align') ? value.align : undefined,
    },
    env,
  );
  const previous = state.textFit[field.id];
  state.textFit[field.id] = {
    fontSize: previous ? Math.min(previous.fontSize, fontSize) : fontSize,
    fits: (previous?.fits ?? true) && fits,
  };
  if (!fits) {
    addError(state, {
      fieldId: field.id,
      code: 'text-overflow',
      message:
        'This text is too wide to fit the print area at the smallest allowed size. Shorten it or choose another font.',
    });
  }
  return op;
}

// ---- images -------------------------------------------------------------------------------------

function imagePlaceholderOp(
  env: EvaluationEnv,
  common: Common,
  layer: ImagePlaceholderLayer,
  field: ImageFieldSpec,
  value: {
    assetId: string | null;
    crop: CropRect | null;
    fit?: 'cover' | 'contain';
    rotation?: QuarterTurns;
  },
  area: PrintableArea,
  shown: boolean,
  options: EvaluationOptions,
  state: EvalState,
): ImageOp | PlaceholderOp | null {
  const empty = () =>
    options.placeholders
      ? placeholderOp(common, layer.placeholderLabel ?? field.placeholder ?? field.label)
      : null;
  if (value.assetId === null) {
    if (field.required && shown)
      addError(state, {
        fieldId: field.id,
        code: 'required',
        message: `${field.label} is required.`,
      });
    return empty();
  }

  const asset = env.localAssets.get(value.assetId);
  if (!asset) {
    addError(state, {
      fieldId: field.id,
      code: 'missing-asset',
      message: 'This photo is no longer available. Upload it again or remove it.',
    });
    return empty();
  }
  if (
    field.minPixels &&
    (asset.width < field.minPixels.width || asset.height < field.minPixels.height)
  ) {
    addError(state, {
      fieldId: field.id,
      code: 'image-too-small',
      message: `This photo is ${asset.width} x ${asset.height} pixels; at least ${field.minPixels.width} x ${field.minPixels.height} is needed.`,
    });
  }

  const turns = (((value.rotation ?? 0) / 90) % 4) as 0 | 1 | 2 | 3;
  const fit = value.fit ?? layer.fit ?? 'cover';
  const size = turnedSize(asset.bitmap, turns);
  let op: ImageOp;
  let crop: CropRect;
  if (fit === 'contain') {
    op = containOp(common, asset.bitmap, turns);
    crop = [0, 0, 1, 1];
  } else {
    const aspect = layer.width / layer.height;
    // A stored crop belongs to one slot shape. When the artwork (or the rotation) changes the slot's
    // aspect ratio, quietly fall back to the centred crop rather than blocking the customer.
    crop =
      value.crop && checkCrop(value.crop, size.w, size.h, aspect).ok
        ? value.crop
        : defaultCrop(size.w, size.h, aspect);
    const { sx, sy, sw, sh } = cropToPixels(crop, size.w, size.h);
    op = {
      ...common,
      kind: 'image',
      source: asset.bitmap,
      turns,
      sx,
      sy,
      sw,
      sh,
      dx: layer.x,
      dy: layer.y,
      dw: layer.width,
      dh: layer.height,
    };
  }

  const { print, canvas } = area;
  if (print) {
    const dpi = effectiveDpi(
      crop,
      size.w,
      size.h,
      op.dw / canvas.width,
      op.dh / canvas.height,
      print.widthMm,
      print.heightMm,
    );
    const { warn, min } = dpiThresholds(print);
    const level: ResolutionLevel =
      min !== null && dpi.effective < min ? 'block' : dpi.effective < warn ? 'warn' : 'ok';
    const known = state.resolution[field.id];
    if (!known || dpi.effective < known.dpi)
      state.resolution[field.id] = { dpi: dpi.effective, level };
    const rounded = Math.round(dpi.effective);
    if (level === 'block') {
      addError(state, {
        fieldId: field.id,
        code: 'low-resolution',
        message: `This photo is too small to print well (${rounded} DPI; at least ${min} is required). Choose a larger photo or zoom out.`,
      });
    } else if (level === 'warn') {
      state.warnings[field.id] = [
        `Low resolution (${rounded} DPI). It may look soft when printed; ${warn} DPI or more is recommended.`,
      ];
    }
  }
  return op;
}

function artworkChoiceOp(
  env: EvaluationEnv,
  common: Common,
  field: ArtworkFieldSpec,
  value: { choiceId: string | null },
  shown: boolean,
  state: EvalState,
): ImageOp | null {
  if (value.choiceId === null) {
    if (field.required && shown)
      addError(state, {
        fieldId: field.id,
        code: 'required',
        message: `Choose an option for ${field.label}.`,
      });
    return null;
  }
  const choice = field.choices.find((c) => c.id === value.choiceId);
  const bitmap = choice ? env.staticImages.get(choice.src) : undefined;
  if (!choice || !bitmap) {
    addError(state, {
      fieldId: field.id,
      code: 'invalid-option',
      message: 'Choose one of the available options.',
    });
    return null;
  }
  return containOp(common, bitmap, 0);
}

// ---- change detection --------------------------------------------------------------------------

const bitmapIds = new WeakMap<object, number>();
let nextBitmapId = 1;

function idOf(source: object): number {
  let id = bitmapIds.get(source);
  if (id === undefined) {
    id = nextBitmapId++;
    bitmapIds.set(source, id);
  }
  return id;
}

/** Cheap signature: equal signatures render identical pixels, so cached canvases can be reused. */
export function sceneSignature(scene: AreaScene): string {
  const parts: unknown[] = [scene.width, scene.height, scene.background, scene.shape];
  for (const op of scene.ops) {
    const base = [op.kind, op.box, op.rotation, op.opacity, op.clip, op.previewOnly ?? false];
    switch (op.kind) {
      case 'image':
        parts.push([
          base,
          idOf(op.source),
          op.turns,
          op.sx,
          op.sy,
          op.sw,
          op.sh,
          op.dx,
          op.dy,
          op.dw,
          op.dh,
        ]);
        break;
      case 'text':
        parts.push([base, op.font, op.color, op.align, op.underline, op.lines]);
        break;
      case 'shape':
        parts.push([base, op.shape, op.fill, op.stroke, op.strokeWidth]);
        break;
      case 'placeholder':
        parts.push([base, op.label]);
        break;
    }
  }
  return JSON.stringify(parts);
}
