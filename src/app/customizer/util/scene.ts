/**
 * The canonical scene. `evaluateDraft` turns (configuration + draft + loaded assets) into
 * a list of draw operations plus every per-field validation result. The display preview, the
 * artwork PNG and the preview PNG all draw this same scene, so they cannot drift apart.
 */

import {
  ArtworkFieldSpec,
  CustomizerConfig,
  ImageFieldSpec,
  LIMITS,
  LayerSpec,
  TextAlign,
  TextFieldSpec,
} from '../models/config.models';
import { FieldError } from '../models/draft.models';
import { checkCrop, cropToPixels, defaultCrop, effectiveDpi } from './crop-math';
import { DraftValues, isArtworkValue, isImageValue, isTextValue } from './draft-utils';
import { InkBox, fitText, placeText } from './text-fit';
import {
  hasVisibleContent,
  normalizeText,
  probeableCharacters,
  structuralTextProblems,
} from './text-utils';

export interface LocalAsset {
  assetId: string;
  /** Canonical re-encoded image (PNG for PNG input, JPEG for JPEG input), without metadata. */
  blob: Blob;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

export interface ImageOp {
  kind: 'image';
  layerId: string;
  source: ImageBitmap;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface TextOp {
  kind: 'text';
  layerId: string;
  text: string;
  /** Canvas font shorthand, e.g. `48px "zb-1a2b-CustomizerSans"`. */
  font: string;
  color: string;
  align: TextAlign;
  /** Anchor x for `align` and alphabetic baseline y, in canvas pixels. */
  x: number;
  y: number;
}

export type SceneOp = ImageOp | TextOp;

export interface Scene {
  width: number;
  height: number;
  background: string;
  ops: SceneOp[];
}

export type ResolutionLevel = 'ok' | 'warn' | 'block';

export interface ImageResolution {
  dpi: number;
  level: ResolutionLevel;
}

export interface Evaluation {
  scene: Scene;
  /** Blocking problems, in field order. */
  errors: FieldError[];
  /** Non-blocking notes per field (e.g. low resolution). */
  warnings: Record<string, string[]>;
  /** Chosen font size per text field. */
  textFit: Record<string, { fontSize: number; fits: boolean }>;
  /** Effective DPI per photo field (only when physical print size is configured). */
  resolution: Record<string, ImageResolution>;
}

export interface EvaluationEnv {
  config: CustomizerConfig;
  /** Config font id -> registered canvas family. */
  fontFamilies: ReadonlyMap<string, string>;
  /** Decoded mockup, artwork and fixed images by absolute URL. */
  staticImages: ReadonlyMap<string, ImageBitmap>;
  localAssets: ReadonlyMap<string, LocalAsset>;
  measure: (font: string, align: TextAlign, text: string) => InkBox;
  /** Returns the characters of `chars` the font cannot draw. */
  missingGlyphs: (family: string, chars: string[]) => string[];
}

export function dpiThresholds(config: CustomizerConfig): { warn: number; min: number } {
  return {
    warn: Math.max(LIMITS.warnDpiFloor, config.print?.warnDpi ?? 0),
    min: Math.max(LIMITS.minDpiFloor, config.print?.minDpi ?? 0),
  };
}

export function evaluateDraft(env: EvaluationEnv, values: DraftValues): Evaluation {
  const { config } = env;
  const errors: FieldError[] = [];
  const warnings: Record<string, string[]> = {};
  const textFit: Evaluation['textFit'] = {};
  const resolution: Evaluation['resolution'] = {};
  const ops: SceneOp[] = [];
  const fields = new Map(config.fields.map((f) => [f.id, f]));
  const fieldOrder = new Map(config.fields.map((f, i) => [f.id, i]));

  for (const layer of config.layers) {
    if (layer.type === 'fixed-image') {
      const bitmap = env.staticImages.get(layer.src);
      if (bitmap) ops.push(containOp(layer, bitmap));
      continue;
    }
    const field = fields.get(layer.fieldId);
    const value = values[layer.fieldId];
    if (!field || !value) continue;

    if (layer.type === 'text' && field.type === 'text' && isTextValue(value)) {
      const op = evaluateText(env, layer, field, value, errors, textFit);
      if (op) ops.push(op);
    } else if (layer.type === 'image' && field.type === 'image' && isImageValue(value)) {
      const op = evaluateImage(env, layer, field, value, errors, warnings, resolution);
      if (op) ops.push(op);
    } else if (layer.type === 'artwork' && field.type === 'artwork' && isArtworkValue(value)) {
      const op = evaluateArtwork(env, layer, field, value, errors);
      if (op) ops.push(op);
    }
  }

  errors.sort((a, b) => (fieldOrder.get(a.fieldId) ?? 0) - (fieldOrder.get(b.fieldId) ?? 0));
  return {
    scene: {
      width: config.canvas.width,
      height: config.canvas.height,
      background: config.canvas.background,
      ops,
    },
    errors,
    warnings,
    textFit,
    resolution,
  };
}

function containOp(
  box: { id: string; x: number; y: number; width: number; height: number },
  bitmap: ImageBitmap,
): ImageOp {
  const scale = Math.min(box.width / bitmap.width, box.height / bitmap.height);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  return {
    kind: 'image',
    layerId: box.id,
    source: bitmap,
    sx: 0,
    sy: 0,
    sw: bitmap.width,
    sh: bitmap.height,
    dx: box.x + (box.width - dw) / 2,
    dy: box.y + (box.height - dh) / 2,
    dw,
    dh,
  };
}

function evaluateText(
  env: EvaluationEnv,
  layer: Extract<LayerSpec, { type: 'text' }>,
  field: TextFieldSpec,
  value: { text: string; fontId: string; color: string },
  errors: FieldError[],
  textFit: Evaluation['textFit'],
): TextOp | null {
  const text = normalizeText(value.text);
  // Spaces, zero-width characters and lone combining marks draw nothing, so they count as empty.
  if (!hasVisibleContent(text)) {
    if (field.required)
      errors.push({ fieldId: field.id, code: 'required', message: `${field.label} is required.` });
    return null;
  }
  const family = env.fontFamilies.get(value.fontId);
  if (!family || !field.fontIds.includes(value.fontId) || !field.colors.includes(value.color)) {
    errors.push({
      fieldId: field.id,
      code: 'invalid-option',
      message: 'Choose one of the available fonts and colours.',
    });
    return null;
  }

  const structural = structuralTextProblems(text, field.maxLength);
  for (const problem of structural) {
    errors.push({ fieldId: field.id, code: problem.code, message: problem.message });
  }
  // Save is blocked anyway while a structural problem exists, so don't spend a glyph probe per new
  // character on (say) a pasted novel. Over-limit text is still previewed unless it is absurdly long.
  if (structural.some((p) => p.code === 'too-long') && text.length > field.maxLength * 8)
    return null;
  const missing =
    structural.length === 0 ? env.missingGlyphs(family, probeableCharacters(text)) : [];
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(' ');
    errors.push({
      fieldId: field.id,
      code: 'unsupported-glyph',
      message: `The selected font can't print: ${shown}${missing.length > 5 ? ' …' : ''}. Remove those characters or choose another font.`,
    });
  }

  const fit = fitText(
    (size) => env.measure(`${size}px "${family}"`, layer.align, text),
    layer,
    layer.fontSize,
    layer.minFontSize,
  );
  textFit[field.id] = { fontSize: fit.fontSize, fits: fit.fits };
  if (!fit.fits) {
    errors.push({
      fieldId: field.id,
      code: 'text-overflow',
      message:
        'This text is too wide to fit the print area at the smallest allowed size. Shorten it or choose another font.',
    });
  }
  const position = placeText(fit.ink, layer, layer.align);
  return {
    kind: 'text',
    layerId: layer.id,
    text,
    font: `${fit.fontSize}px "${family}"`,
    color: value.color,
    align: layer.align,
    x: position.x,
    y: position.y,
  };
}

function evaluateImage(
  env: EvaluationEnv,
  layer: Extract<LayerSpec, { type: 'image' }>,
  field: ImageFieldSpec,
  value: { assetId: string | null; crop: readonly [number, number, number, number] | null },
  errors: FieldError[],
  warnings: Record<string, string[]>,
  resolution: Evaluation['resolution'],
): ImageOp | null {
  if (value.assetId === null) {
    if (field.required)
      errors.push({ fieldId: field.id, code: 'required', message: `${field.label} is required.` });
    return null;
  }
  const asset = env.localAssets.get(value.assetId);
  if (!asset) {
    errors.push({
      fieldId: field.id,
      code: 'missing-asset',
      message: 'This photo is no longer available. Upload it again or remove it.',
    });
    return null;
  }
  const aspect = layer.width / layer.height;
  let crop = value.crop ?? defaultCrop(asset.width, asset.height, aspect);
  const check = checkCrop(crop, asset.width, asset.height, aspect);
  if (!check.ok) {
    errors.push({
      fieldId: field.id,
      code: 'invalid-crop',
      message: 'The saved crop does not fit this photo area. Reset the crop to continue.',
    });
    crop = defaultCrop(asset.width, asset.height, aspect);
  }

  const { config } = env;
  if (config.print) {
    const dpi = effectiveDpi(
      crop,
      asset.width,
      asset.height,
      layer.width / config.canvas.width,
      layer.height / config.canvas.height,
      config.print.widthMm,
      config.print.heightMm,
    );
    const { warn, min } = dpiThresholds(config);
    const level: ResolutionLevel =
      dpi.effective < min ? 'block' : dpi.effective < warn ? 'warn' : 'ok';
    resolution[field.id] = { dpi: dpi.effective, level };
    const rounded = Math.round(dpi.effective);
    if (level === 'block') {
      errors.push({
        fieldId: field.id,
        code: 'low-resolution',
        message: `This photo is too small to print well (${rounded} DPI; at least ${min} is required). Choose a larger photo or zoom out.`,
      });
    } else if (level === 'warn') {
      warnings[field.id] = [
        `Low resolution (${rounded} DPI). It may look soft when printed; ${warn} DPI or more is recommended.`,
      ];
    }
  }

  const { sx, sy, sw, sh } = cropToPixels(crop, asset.width, asset.height);
  return {
    kind: 'image',
    layerId: layer.id,
    source: asset.bitmap,
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

function evaluateArtwork(
  env: EvaluationEnv,
  layer: Extract<LayerSpec, { type: 'artwork' }>,
  field: ArtworkFieldSpec,
  value: { choiceId: string | null },
  errors: FieldError[],
): ImageOp | null {
  if (value.choiceId === null) {
    if (field.required)
      errors.push({
        fieldId: field.id,
        code: 'required',
        message: `Choose an option for ${field.label}.`,
      });
    return null;
  }
  const choice = field.choices.find((c) => c.id === value.choiceId);
  const bitmap = choice ? env.staticImages.get(choice.src) : undefined;
  if (!choice || !bitmap) {
    errors.push({
      fieldId: field.id,
      code: 'invalid-option',
      message: 'Choose one of the available options.',
    });
    return null;
  }
  return containOp(layer, bitmap);
}
