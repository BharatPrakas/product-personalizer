/**
 * Runtime validation of fetched / supplied configuration. TypeScript types alone don't validate
 * JSON, and a JSON Schema validator that compiles code (Ajv) would need `unsafe-eval` on strict
 * host CSPs, so the rules are written out here. `public/schema/customizer-config.schema.json`
 * describes the same contract for authoring tools and is cross-checked in the tests.
 *
 * Success returns a deep copy in which every asset URL is absolute and has passed the URL policy.
 */

import {
  AcceptedImageType,
  ArtworkChoice,
  CanvasSpec,
  ConfigIssue,
  CustomizerConfig,
  DisplayPriceSpec,
  FieldBase,
  FieldSpec,
  FontSpec,
  LIMITS,
  LayerSpec,
  MockupSpec,
  PrintSpec,
  ProductSpec,
  SCHEMA_VERSION,
  TextAlign,
  TextFieldDefault,
  TextStyleControl,
} from '../models/config.models';
import type { Condition } from '../models/product.models';
import { ASPECT_TOLERANCE } from './crop-math';
import { graphemeCount, normalizeText } from './text-utils';
import { AssetPolicy, ResolvedBase, checkAssetSrc, resolveAssetDir } from './url-policy';

export type ValidationResult =
  { ok: true; config: CustomizerConfig } | { ok: false; issues: ConfigIssue[] };

export interface ValidateOptions {
  resolvedBase: ResolvedBase;
  policy: AssetPolicy;
}

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT_FAMILY_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_ISSUES = 100;
export const GEOMETRY_SLACK = 1e-6;

export type Obj = Record<string, unknown>;

export class Collector {
  readonly issues: ConfigIssue[] = [];

  add(path: string, code: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, code, message });
  }

  get count(): number {
    return this.issues.length;
  }

  object(value: unknown, path: string, allowed: readonly string[]): Obj | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.add(path, 'type', 'must be an object');
      return null;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.add(`${path}.${key}`, 'unknown-property', `unknown property "${key}"`);
      }
    }
    return value as Obj;
  }

  array(value: unknown, path: string, min: number, max: number): unknown[] | null {
    if (!Array.isArray(value)) {
      this.add(path, 'type', 'must be an array');
      return null;
    }
    if (value.length < min || value.length > max) {
      this.add(
        path,
        'length',
        `must contain ${min === max ? min : `${min} to ${max}`} item(s) (found ${value.length})`,
      );
      return value.length > max ? value.slice(0, max) : value;
    }
    return value;
  }

  string(value: unknown, path: string, min = 1, max = 200): string | null {
    if (typeof value !== 'string') {
      this.add(path, 'type', 'must be a string');
      return null;
    }
    if (value.length < min || value.length > max) {
      this.add(path, 'length', `must be ${min}-${max} characters`);
      return null;
    }
    return value;
  }

  id(value: unknown, path: string): string | null {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      this.add(
        path,
        'id',
        'must be 1-64 characters of letters, digits, "_" or "-", starting with a letter or digit',
      );
      return null;
    }
    // Ids become keys of plain objects (draft values, error maps); names such as "constructor" or
    // "toString" would resolve to Object.prototype members there.
    if (value in Object.prototype) {
      this.add(path, 'reserved-id', `"${value}" is a reserved name; choose another id`);
      return null;
    }
    return value;
  }

  number(value: unknown, path: string, min: number, max: number, integer = false): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, 'type', 'must be a finite number');
      return null;
    }
    if (integer && !Number.isInteger(value)) {
      this.add(path, 'integer', 'must be an integer');
      return null;
    }
    if (value < min || value > max) {
      this.add(path, 'range', `must be between ${min} and ${max}`);
      return null;
    }
    return value;
  }

  boolean(value: unknown, path: string): boolean | null {
    if (typeof value !== 'boolean') {
      this.add(path, 'type', 'must be true or false');
      return null;
    }
    return value;
  }

  color(value: unknown, path: string): string | null {
    if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
      this.add(path, 'color', 'must be a hex colour such as #296FD7');
      return null;
    }
    return value;
  }

  requireUnique(ids: (string | null)[], path: string): void {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (id === null) return;
      if (seen.has(id)) this.add(`${path}[${index}].id`, 'duplicate-id', `duplicate id "${id}"`);
      seen.add(id);
    });
  }
}

export function validateConfig(raw: unknown, options: ValidateOptions): ValidationResult {
  const c = new Collector();
  const root = c.object(raw, '', [
    'schemaVersion',
    'templateId',
    'templateVersion',
    'product',
    'assetBaseUrl',
    'canvas',
    'print',
    'mockup',
    'fonts',
    'fields',
    'layers',
    'displayPrice',
  ]);
  if (!root) return { ok: false, issues: c.issues };

  if (root['schemaVersion'] !== SCHEMA_VERSION) {
    c.add(
      'schemaVersion',
      'unsupported-version',
      `unsupported schemaVersion ${JSON.stringify(root['schemaVersion'])}; this build supports ${SCHEMA_VERSION}`,
    );
    // Other rules may differ between versions: stop here.
    return { ok: false, issues: c.issues };
  }

  const templateId = c.id(root['templateId'], 'templateId');
  const templateVersion = c.number(root['templateVersion'], 'templateVersion', 1, 1_000_000, true);
  const product = validateProduct(root['product'], c);

  const assetDir = resolveAssetDir(
    root['assetBaseUrl'] === undefined ? undefined : (root['assetBaseUrl'] as string),
    options.resolvedBase,
    options.policy,
  );
  let assetBaseUrl: string | undefined;
  if (assetDir.ok) {
    assetBaseUrl = assetDir.url;
  } else {
    c.add('assetBaseUrl', assetDir.code, assetDir.message);
  }
  const resolveSrc = (value: unknown, path: string): string | null => {
    if (!assetBaseUrl) return null;
    const checked = checkAssetSrc(value, assetBaseUrl, options.policy);
    if (!checked.ok) {
      c.add(path, checked.code, checked.message);
      return null;
    }
    return checked.url;
  };

  const canvas = validateCanvas(root['canvas'], c);
  const print = root['print'] === undefined ? undefined : validatePrint(root['print'], canvas, c);
  const mockup = validateMockup(root['mockup'], resolveSrc, c);
  const fonts = validateFonts(root['fonts'], resolveSrc, c);
  const fieldIds = new Map<string, FieldSpec['type']>();
  const fields = validateFields(root['fields'], fonts, resolveSrc, fieldIds, c);
  const layers = validateLayers(root['layers'], canvas, fields, resolveSrc, c);
  const displayPrice =
    root['displayPrice'] === undefined ? undefined : validateDisplayPrice(root['displayPrice'], c);

  if (c.count > 0 || !templateId || templateVersion === null || !product || !canvas || !mockup) {
    return { ok: false, issues: c.issues };
  }

  const config: CustomizerConfig = {
    schemaVersion: SCHEMA_VERSION,
    templateId,
    templateVersion,
    product,
    ...(assetBaseUrl ? { assetBaseUrl } : {}),
    canvas,
    ...(print ? { print } : {}),
    mockup,
    fonts,
    fields,
    layers,
    ...(displayPrice ? { displayPrice } : {}),
  };
  return { ok: true, config };
}

export type SrcResolver = (value: unknown, path: string) => string | null;

export function validateProduct(value: unknown, c: Collector): ProductSpec | null {
  const o = c.object(value, 'product', ['id', 'variantId', 'name']);
  if (!o) return null;
  const id = c.id(o['id'], 'product.id');
  const variantId =
    o['variantId'] === undefined ? undefined : c.id(o['variantId'], 'product.variantId');
  const name = c.string(o['name'], 'product.name', 1, 120);
  if (!id || name === null || variantId === null) return null;
  return { id, ...(variantId ? { variantId } : {}), name };
}

export function validateCanvas(value: unknown, c: Collector, path = 'canvas'): CanvasSpec | null {
  const o = c.object(value, path, ['width', 'height', 'background']);
  if (!o) return null;
  const width = c.number(o['width'], `${path}.width`, 1, LIMITS.maxOutputEdge, true);
  const height = c.number(o['height'], `${path}.height`, 1, LIMITS.maxOutputEdge, true);
  let background = 'transparent';
  if (o['background'] !== undefined && o['background'] !== 'transparent') {
    background = c.color(o['background'], `${path}.background`) ?? 'transparent';
  }
  if (width === null || height === null) return null;
  if (width * height > LIMITS.maxOutputMegapixels * 1_000_000) {
    c.add(path, 'too-large', `must be at most ${LIMITS.maxOutputMegapixels} megapixels`);
    return null;
  }
  return { width, height, background };
}

export function validatePrint(
  value: unknown,
  canvas: CanvasSpec | null,
  c: Collector,
  path = 'print',
): PrintSpec | undefined {
  const o = c.object(value, path, ['widthMm', 'heightMm', 'warnDpi', 'minDpi']);
  if (!o) return undefined;
  const widthMm = c.number(o['widthMm'], `${path}.widthMm`, 1, 100_000);
  const heightMm = c.number(o['heightMm'], `${path}.heightMm`, 1, 100_000);
  const warnDpi =
    o['warnDpi'] === undefined
      ? undefined
      : c.number(o['warnDpi'], `${path}.warnDpi`, LIMITS.warnDpiFloor, 10_000);
  const minDpi =
    o['minDpi'] === undefined
      ? undefined
      : c.number(o['minDpi'], `${path}.minDpi`, LIMITS.minDpiFloor, 10_000);
  if (warnDpi != null && minDpi != null && minDpi > warnDpi) {
    c.add(`${path}.minDpi`, 'range', `must not exceed ${path}.warnDpi`);
  }
  if (widthMm === null || heightMm === null) return undefined;
  if (canvas) {
    const canvasAspect = canvas.width / canvas.height;
    if (Math.abs(widthMm / heightMm - canvasAspect) / canvasAspect > ASPECT_TOLERANCE) {
      c.add(
        path,
        'aspect-mismatch',
        'print aspect ratio (widthMm / heightMm) must match the canvas aspect ratio',
      );
    }
  }
  return {
    widthMm,
    heightMm,
    ...(warnDpi != null ? { warnDpi } : {}),
    ...(minDpi != null ? { minDpi } : {}),
  };
}

function validateMockup(value: unknown, resolveSrc: SrcResolver, c: Collector): MockupSpec | null {
  const o = c.object(value, 'mockup', ['src', 'placement']);
  if (!o) return null;
  const src = resolveSrc(o['src'], 'mockup.src');
  const p = c.object(o['placement'], 'mockup.placement', ['x', 'y', 'width', 'height']);
  if (!p) return null;
  const x = c.number(p['x'], 'mockup.placement.x', 0, 1);
  const y = c.number(p['y'], 'mockup.placement.y', 0, 1);
  const width = c.number(p['width'], 'mockup.placement.width', 0, 1);
  const height = c.number(p['height'], 'mockup.placement.height', 0, 1);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) {
    c.add('mockup.placement', 'range', 'width and height must be greater than 0');
    return null;
  }
  if (x + width > 1 + GEOMETRY_SLACK || y + height > 1 + GEOMETRY_SLACK) {
    c.add('mockup.placement', 'bounds', 'placement must lie inside the mockup image (0..1)');
    return null;
  }
  return src ? { src, placement: { x, y, width, height } } : null;
}

/**
 * Needs the decoded mockup size, so it runs after the image has loaded. Rejects (rather than
 * stretches) a placement whose pixel aspect ratio differs from the canvas.
 */
export function checkMockupGeometry(
  config: CustomizerConfig,
  mockupWidth: number,
  mockupHeight: number,
): ConfigIssue | null {
  const { placement } = config.mockup;
  const placementAspect = (placement.width * mockupWidth) / (placement.height * mockupHeight);
  const canvasAspect = config.canvas.width / config.canvas.height;
  if (Math.abs(placementAspect - canvasAspect) / canvasAspect > 0.01) {
    return {
      path: 'mockup.placement',
      code: 'mockup-aspect-mismatch',
      message:
        `placement is ${placementAspect.toFixed(3)}:1 on the ${mockupWidth}x${mockupHeight} mockup ` +
        `but the canvas is ${canvasAspect.toFixed(3)}:1; the artwork would be stretched`,
    };
  }
  return null;
}

export function validateFonts(
  value: unknown,
  resolveSrc: SrcResolver,
  c: Collector,
  maxFonts: number = LIMITS.maxFonts,
): FontSpec[] {
  const list = c.array(value, 'fonts', 1, maxFonts) ?? [];
  const fonts: (FontSpec | null)[] = list.map((item, index) => {
    const path = `fonts[${index}]`;
    const o = c.object(item, path, ['id', 'family', 'src', 'label']);
    if (!o) return null;
    const id = c.id(o['id'], `${path}.id`);
    const family = c.string(o['family'], `${path}.family`, 1, 64);
    if (family !== null && !FONT_FAMILY_PATTERN.test(family)) {
      c.add(
        `${path}.family`,
        'font-family',
        'must start with a letter and use only letters, digits, spaces, "_" or "-"',
      );
    }
    const label =
      o['label'] === undefined ? undefined : c.string(o['label'], `${path}.label`, 1, 40);
    const src = resolveSrc(o['src'], `${path}.src`);
    if (!id || !family || !FONT_FAMILY_PATTERN.test(family) || !src || label === null) return null;
    return { id, family, src, ...(label ? { label } : {}) };
  });
  c.requireUnique(
    fonts.map((f) => f?.id ?? null),
    'fonts',
  );
  return fonts.filter((f): f is FontSpec => f !== null);
}

export interface FieldValidationOptions {
  /** Schema version 2: accept the extended field properties. */
  extended: boolean;
  maxFields: number;
  maxFonts: number;
  /** Upper bound for a text field's `maxLength` (graphemes). */
  maxTextLength: number;
}

const V1_FIELD_OPTIONS: FieldValidationOptions = {
  extended: false,
  maxFields: LIMITS.maxFields,
  maxFonts: LIMITS.maxFonts,
  maxTextLength: LIMITS.maxTextGraphemes,
};

export function validateFields(
  value: unknown,
  fonts: FontSpec[],
  resolveSrc: SrcResolver,
  fieldTypes: Map<string, FieldSpec['type']>,
  c: Collector,
  opts: FieldValidationOptions = V1_FIELD_OPTIONS,
): FieldSpec[] {
  const list = c.array(value, 'fields', 1, opts.maxFields) ?? [];
  const fontIds = new Set(fonts.map((f) => f.id));
  const fields: (FieldSpec | null)[] = list.map((item, index) => {
    const path = `fields[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      c.add(path, 'type', 'must be an object');
      return null;
    }
    const type = (item as Obj)['type'];
    switch (type) {
      case 'text':
        return validateTextField(item, path, fontIds, c, opts);
      case 'image':
        return validateImageField(item, path, c, opts);
      case 'artwork':
        return validateArtworkField(item, path, resolveSrc, c, opts);
      default:
        c.add(
          `${path}.type`,
          'unknown-type',
          `unknown field type ${JSON.stringify(type)}; expected text, image or artwork`,
        );
        return null;
    }
  });
  c.requireUnique(
    fields.map((f) => f?.id ?? null),
    'fields',
  );
  for (const field of fields) if (field) fieldTypes.set(field.id, field.type);
  return fields.filter((f): f is FieldSpec => f !== null);
}

const EXTENDED_FIELD_KEYS = ['placeholder', 'visible', 'printableAreaId', 'artworkId', 'showWhen'];

function commonField(o: Obj, path: string, c: Collector, opts: FieldValidationOptions) {
  const id = c.id(o['id'], `${path}.id`);
  const label = c.string(o['label'], `${path}.label`, 1, 80);
  const helpText =
    o['helpText'] === undefined ? undefined : c.string(o['helpText'], `${path}.helpText`, 1, 240);
  const required = c.boolean(o['required'], `${path}.required`);
  const extra: Partial<FieldBase> = {};
  if (opts.extended) {
    if (o['placeholder'] !== undefined) {
      const placeholder = c.string(o['placeholder'], `${path}.placeholder`, 1, 80);
      if (placeholder !== null) extra.placeholder = placeholder;
    }
    if (o['visible'] !== undefined) {
      const visible = c.boolean(o['visible'], `${path}.visible`);
      if (visible !== null) extra.visible = visible;
    }
    for (const key of ['printableAreaId', 'artworkId'] as const) {
      if (o[key] !== undefined) {
        const ref = c.id(o[key], `${path}.${key}`);
        if (ref !== null) extra[key] = ref;
      }
    }
    if (o['showWhen'] !== undefined) {
      const condition = validateCondition(o['showWhen'], `${path}.showWhen`, c, 0);
      if (condition) extra.showWhen = condition;
    }
  }
  return { id, label, helpText, required, extra };
}

const CONDITION_OPS = ['artwork', 'variant', 'field-equals', 'field-filled', 'all', 'any', 'not'];

/** Structure only; references are checked once the whole configuration is known. */
export function validateCondition(
  value: unknown,
  path: string,
  c: Collector,
  depth: number,
): Condition | null {
  if (depth > 4) {
    c.add(path, 'depth', 'conditions may be nested at most 4 levels deep');
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    c.add(path, 'type', 'must be an object');
    return null;
  }
  const op = (value as Obj)['op'];
  if (typeof op !== 'string' || !CONDITION_OPS.includes(op)) {
    c.add(`${path}.op`, 'enum', `must be one of ${CONDITION_OPS.join(', ')}`);
    return null;
  }
  switch (op) {
    case 'artwork': {
      const o = c.object(value, path, ['op', 'artworkId', 'printableAreaId']);
      if (!o) return null;
      const artworkId = c.id(o['artworkId'], `${path}.artworkId`);
      const areaId =
        o['printableAreaId'] === undefined
          ? undefined
          : c.id(o['printableAreaId'], `${path}.printableAreaId`);
      return artworkId && areaId !== null
        ? { op, artworkId, ...(areaId ? { printableAreaId: areaId } : {}) }
        : null;
    }
    case 'variant': {
      const o = c.object(value, path, ['op', 'variantIds']);
      if (!o) return null;
      const list = c.array(o['variantIds'], `${path}.variantIds`, 1, 40) ?? [];
      const ids = list
        .map((id, i) => c.id(id, `${path}.variantIds[${i}]`))
        .filter((id): id is string => id !== null);
      return ids.length > 0 ? { op, variantIds: ids } : null;
    }
    case 'field-equals': {
      const o = c.object(value, path, ['op', 'fieldId', 'value']);
      if (!o) return null;
      const fieldId = c.id(o['fieldId'], `${path}.fieldId`);
      const v = o['value'];
      if (typeof v !== 'string' && typeof v !== 'boolean') {
        c.add(`${path}.value`, 'type', 'must be a string or boolean');
        return null;
      }
      return fieldId ? { op, fieldId, value: v } : null;
    }
    case 'field-filled': {
      const o = c.object(value, path, ['op', 'fieldId']);
      if (!o) return null;
      const fieldId = c.id(o['fieldId'], `${path}.fieldId`);
      return fieldId ? { op, fieldId } : null;
    }
    case 'not': {
      const o = c.object(value, path, ['op', 'condition']);
      if (!o) return null;
      const inner = validateCondition(o['condition'], `${path}.condition`, c, depth + 1);
      return inner ? { op, condition: inner } : null;
    }
    default: {
      const o = c.object(value, path, ['op', 'conditions']);
      if (!o) return null;
      const list = c.array(o['conditions'], `${path}.conditions`, 1, 8) ?? [];
      const inner = list
        .map((entry, i) => validateCondition(entry, `${path}.conditions[${i}]`, c, depth + 1))
        .filter((entry): entry is Condition => entry !== null);
      return inner.length === list.length && inner.length > 0
        ? { op: op as 'all' | 'any', conditions: inner }
        : null;
    }
  }
}

function validateTextField(
  item: unknown,
  path: string,
  fontIds: Set<string>,
  c: Collector,
  opts: FieldValidationOptions,
): FieldSpec | null {
  const o = c.object(item, path, [
    'id',
    'type',
    'label',
    'helpText',
    'required',
    'maxLength',
    'fontIds',
    'colors',
    'defaultValue',
    ...(opts.extended ? [...EXTENDED_FIELD_KEYS, 'styleControls'] : []),
  ]);
  if (!o) return null;
  const base = commonField(o, path, c, opts);
  const maxLength = c.number(o['maxLength'], `${path}.maxLength`, 1, opts.maxTextLength, true);

  const fontList = c.array(o['fontIds'], `${path}.fontIds`, 1, opts.maxFonts) ?? [];
  const fonts = fontList.filter((id): id is string => {
    const ok = typeof id === 'string' && fontIds.has(id);
    if (!ok)
      c.add(
        `${path}.fontIds`,
        'unknown-reference',
        `font ${JSON.stringify(id)} is not declared in "fonts"`,
      );
    return ok;
  });
  if (new Set(fonts).size !== fonts.length)
    c.add(`${path}.fontIds`, 'duplicate-id', 'must not repeat a font');

  const colorList = c.array(o['colors'], `${path}.colors`, 1, LIMITS.maxColorsPerField) ?? [];
  const colors = colorList
    .map((color, i) => c.color(color, `${path}.colors[${i}]`))
    .filter((color): color is string => color !== null);
  if (new Set(colors).size !== colors.length)
    c.add(`${path}.colors`, 'duplicate-id', 'must not repeat a colour');

  let defaultValue: TextFieldDefault | undefined;
  if (o['defaultValue'] !== undefined) {
    const d = c.object(o['defaultValue'], `${path}.defaultValue`, [
      'text',
      'fontId',
      'color',
      ...(opts.extended ? ['bold', 'italic', 'underline', 'align'] : []),
    ]);
    if (d) {
      defaultValue = {};
      if (d['text'] !== undefined) {
        const text = c.string(d['text'], `${path}.defaultValue.text`, 0, 1000);
        if (text !== null) {
          const normalised = normalizeText(text);
          if (maxLength !== null && graphemeCount(normalised) > maxLength) {
            c.add(
              `${path}.defaultValue.text`,
              'too-long',
              `must be at most ${maxLength} characters`,
            );
          }
          defaultValue.text = normalised;
        }
      }
      if (d['fontId'] !== undefined) {
        if (typeof d['fontId'] === 'string' && fonts.includes(d['fontId']))
          defaultValue.fontId = d['fontId'];
        else
          c.add(
            `${path}.defaultValue.fontId`,
            'unknown-reference',
            "must be one of the field's fontIds",
          );
      }
      if (d['color'] !== undefined) {
        if (typeof d['color'] === 'string' && colors.includes(d['color']))
          defaultValue.color = d['color'];
        else
          c.add(
            `${path}.defaultValue.color`,
            'unknown-reference',
            "must be one of the field's colors",
          );
      }
      for (const key of ['bold', 'italic', 'underline'] as const) {
        if (d[key] === undefined) continue;
        const flag = c.boolean(d[key], `${path}.defaultValue.${key}`);
        if (flag !== null) defaultValue[key] = flag;
      }
      if (d['align'] !== undefined) {
        if (d['align'] === 'left' || d['align'] === 'center' || d['align'] === 'right')
          defaultValue.align = d['align'];
        else c.add(`${path}.defaultValue.align`, 'enum', 'must be "left", "center" or "right"');
      }
    }
  }
  let styleControls: TextStyleControl[] | undefined;
  if (opts.extended && o['styleControls'] !== undefined) {
    const list = c.array(o['styleControls'], `${path}.styleControls`, 0, 4) ?? [];
    styleControls = list.filter((entry): entry is TextStyleControl => {
      const ok =
        entry === 'bold' || entry === 'italic' || entry === 'underline' || entry === 'align';
      if (!ok)
        c.add(`${path}.styleControls`, 'enum', 'entries must be bold, italic, underline or align');
      return ok;
    });
  }
  if (
    !base.id ||
    !base.label ||
    base.required === null ||
    maxLength === null ||
    base.helpText === null
  )
    return null;
  return {
    id: base.id,
    type: 'text',
    label: base.label,
    ...(base.helpText ? { helpText: base.helpText } : {}),
    required: base.required,
    ...base.extra,
    maxLength,
    fontIds: fonts,
    colors,
    ...(defaultValue ? { defaultValue } : {}),
    ...(styleControls ? { styleControls } : {}),
  };
}

function validateImageField(
  item: unknown,
  path: string,
  c: Collector,
  opts: FieldValidationOptions,
): FieldSpec | null {
  const o = c.object(item, path, [
    'id',
    'type',
    'label',
    'helpText',
    'required',
    ...(opts.extended ? [...EXTENDED_FIELD_KEYS, 'accept', 'maxBytes', 'minPixels'] : []),
  ]);
  if (!o) return null;
  const base = commonField(o, path, c, opts);
  let accept: AcceptedImageType[] | undefined;
  let maxBytes: number | undefined;
  let minPixels: { width: number; height: number } | undefined;
  if (opts.extended) {
    if (o['accept'] !== undefined) {
      const list = c.array(o['accept'], `${path}.accept`, 1, 2) ?? [];
      accept = list.filter((t): t is AcceptedImageType => {
        const ok = t === 'image/png' || t === 'image/jpeg';
        if (!ok) c.add(`${path}.accept`, 'enum', 'entries must be image/png or image/jpeg');
        return ok;
      });
    }
    if (o['maxBytes'] !== undefined) {
      maxBytes =
        c.number(o['maxBytes'], `${path}.maxBytes`, 1024, LIMITS.maxImageBytes, true) ?? undefined;
    }
    if (o['minPixels'] !== undefined) {
      const m = c.object(o['minPixels'], `${path}.minPixels`, ['width', 'height']);
      if (m) {
        const width = c.number(m['width'], `${path}.minPixels.width`, 1, 20_000, true);
        const height = c.number(m['height'], `${path}.minPixels.height`, 1, 20_000, true);
        if (width !== null && height !== null) minPixels = { width, height };
      }
    }
  }
  if (!base.id || !base.label || base.required === null || base.helpText === null) return null;
  return {
    id: base.id,
    type: 'image',
    label: base.label,
    ...(base.helpText ? { helpText: base.helpText } : {}),
    required: base.required,
    ...base.extra,
    ...(accept ? { accept } : {}),
    ...(maxBytes ? { maxBytes } : {}),
    ...(minPixels ? { minPixels } : {}),
  };
}

function validateArtworkField(
  item: unknown,
  path: string,
  resolveSrc: SrcResolver,
  c: Collector,
  opts: FieldValidationOptions,
): FieldSpec | null {
  const o = c.object(item, path, [
    'id',
    'type',
    'label',
    'helpText',
    'required',
    'choices',
    'defaultChoiceId',
    ...(opts.extended ? EXTENDED_FIELD_KEYS : []),
  ]);
  if (!o) return null;
  const base = commonField(o, path, c, opts);
  const list = c.array(o['choices'], `${path}.choices`, 1, LIMITS.maxChoicesPerField) ?? [];
  const choices: (ArtworkChoice | null)[] = list.map((entry, index) => {
    const cp = `${path}.choices[${index}]`;
    const co = c.object(entry, cp, ['id', 'label', 'src', 'thumbnailSrc']);
    if (!co) return null;
    const id = c.id(co['id'], `${cp}.id`);
    const label = c.string(co['label'], `${cp}.label`, 1, 60);
    const src = resolveSrc(co['src'], `${cp}.src`);
    const thumbnailSrc =
      co['thumbnailSrc'] === undefined
        ? undefined
        : resolveSrc(co['thumbnailSrc'], `${cp}.thumbnailSrc`);
    if (!id || !label || !src || thumbnailSrc === null) return null;
    return { id, label, src, ...(thumbnailSrc ? { thumbnailSrc } : {}) };
  });
  c.requireUnique(
    choices.map((choice) => choice?.id ?? null),
    `${path}.choices`,
  );
  const valid = choices.filter((choice): choice is ArtworkChoice => choice !== null);
  let defaultChoiceId: string | undefined;
  if (o['defaultChoiceId'] !== undefined) {
    if (
      typeof o['defaultChoiceId'] === 'string' &&
      valid.some((choice) => choice.id === o['defaultChoiceId'])
    ) {
      defaultChoiceId = o['defaultChoiceId'];
    } else {
      c.add(`${path}.defaultChoiceId`, 'unknown-reference', 'must be the id of one of the choices');
    }
  }
  if (!base.id || !base.label || base.required === null || base.helpText === null) return null;
  return {
    id: base.id,
    type: 'artwork',
    label: base.label,
    ...(base.helpText ? { helpText: base.helpText } : {}),
    required: base.required,
    ...base.extra,
    choices: valid,
    ...(defaultChoiceId ? { defaultChoiceId } : {}),
  };
}

function validateLayers(
  value: unknown,
  canvas: CanvasSpec | null,
  fields: FieldSpec[],
  resolveSrc: SrcResolver,
  c: Collector,
): LayerSpec[] {
  const list = c.array(value, 'layers', 1, LIMITS.maxLayers) ?? [];
  const fieldType = new Map(fields.map((f) => [f.id, f.type]));
  const referenced = new Map<string, number>();

  const layers: (LayerSpec | null)[] = list.map((item, index) => {
    const path = `layers[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      c.add(path, 'type', 'must be an object');
      return null;
    }
    const type = (item as Obj)['type'];
    const keys = ['id', 'type', 'x', 'y', 'width', 'height'];
    switch (type) {
      case 'image':
      case 'artwork':
      case 'text': {
        const extra = type === 'text' ? ['fontSize', 'minFontSize', 'align'] : [];
        const o = c.object(item, path, [...keys, 'fieldId', ...extra]);
        if (!o) return null;
        const geometry = validateGeometry(o, path, canvas, c);
        const fieldId = typeof o['fieldId'] === 'string' ? o['fieldId'] : null;
        if (fieldId === null) {
          c.add(`${path}.fieldId`, 'type', 'editable layers must reference a field');
        } else if (!fieldType.has(fieldId)) {
          c.add(
            `${path}.fieldId`,
            'unknown-reference',
            `field "${fieldId}" is not declared in "fields"`,
          );
        } else if (fieldType.get(fieldId) !== type) {
          c.add(
            `${path}.fieldId`,
            'type-mismatch',
            `a ${type} layer needs a ${type} field, but "${fieldId}" is a ${fieldType.get(fieldId)} field`,
          );
        } else {
          referenced.set(fieldId, (referenced.get(fieldId) ?? 0) + 1);
          if (referenced.get(fieldId)! > 1) {
            c.add(
              `${path}.fieldId`,
              'multiple-layers',
              `field "${fieldId}" already has a layer; v1 allows one layer per field`,
            );
          }
        }
        if (type === 'text') {
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
          const align = o['align'];
          if (align !== 'left' && align !== 'center' && align !== 'right') {
            c.add(`${path}.align`, 'enum', 'must be "left", "center" or "right"');
          }
          if (
            !geometry ||
            fieldId === null ||
            fontSize === null ||
            minFontSize === null ||
            (align !== 'left' && align !== 'center' && align !== 'right')
          )
            return null;
          return { type, fieldId, ...geometry, fontSize, minFontSize, align: align as TextAlign };
        }
        return geometry && fieldId !== null ? { type, fieldId, ...geometry } : null;
      }
      case 'fixed-image': {
        const o = c.object(item, path, [...keys, 'src']);
        if (!o) return null;
        const geometry = validateGeometry(o, path, canvas, c);
        const src = resolveSrc(o['src'], `${path}.src`);
        return geometry && src ? { type, src, ...geometry } : null;
      }
      default:
        c.add(
          `${path}.type`,
          'unknown-type',
          `unknown layer type ${JSON.stringify(type)}; expected image, text, artwork or fixed-image`,
        );
        return null;
    }
  });

  c.requireUnique(
    layers.map((l) => l?.id ?? null),
    'layers',
  );
  for (const field of fields) {
    if (!referenced.has(field.id)) {
      c.add(
        'layers',
        'field-without-layer',
        `field "${field.id}" has no layer, so it would have no effect on the product`,
      );
    }
  }
  return layers.filter((l): l is LayerSpec => l !== null);
}

function validateGeometry(o: Obj, path: string, canvas: CanvasSpec | null, c: Collector) {
  const id = c.id(o['id'], `${path}.id`);
  const x = c.number(o['x'], `${path}.x`, 0, LIMITS.maxOutputEdge);
  const y = c.number(o['y'], `${path}.y`, 0, LIMITS.maxOutputEdge);
  const width = c.number(o['width'], `${path}.width`, 0, LIMITS.maxOutputEdge);
  const height = c.number(o['height'], `${path}.height`, 0, LIMITS.maxOutputEdge);
  if (!id || x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) {
    c.add(path, 'range', 'width and height must be greater than 0');
    return null;
  }
  if (
    canvas &&
    (x + width > canvas.width + GEOMETRY_SLACK || y + height > canvas.height + GEOMETRY_SLACK)
  ) {
    c.add(path, 'bounds', `layer must fit inside the ${canvas.width}x${canvas.height} canvas`);
    return null;
  }
  return { id, x, y, width, height };
}

export function validateDisplayPrice(value: unknown, c: Collector): DisplayPriceSpec | undefined {
  const o = c.object(value, 'displayPrice', [
    'currency',
    'exponent',
    'baseMinor',
    'customizationFeeMinor',
  ]);
  if (!o) return undefined;
  const currency =
    typeof o['currency'] === 'string' && CURRENCY_PATTERN.test(o['currency'])
      ? o['currency']
      : null;
  if (currency === null)
    c.add('displayPrice.currency', 'currency', 'must be a three-letter ISO 4217 code such as INR');
  const exponent = c.number(o['exponent'], 'displayPrice.exponent', 0, 4, true);
  const baseMinor = c.number(
    o['baseMinor'],
    'displayPrice.baseMinor',
    0,
    Number.MAX_SAFE_INTEGER / 2,
    true,
  );
  const fee = c.number(
    o['customizationFeeMinor'],
    'displayPrice.customizationFeeMinor',
    0,
    Number.MAX_SAFE_INTEGER / 2,
    true,
  );
  if (currency === null || exponent === null || baseMinor === null || fee === null)
    return undefined;
  return { currency, exponent, baseMinor, customizationFeeMinor: fee };
}
