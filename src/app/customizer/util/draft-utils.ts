/** Building, restoring and comparing the serialisable draft. Pure functions. */

import { FieldSpec, SCHEMA_VERSION } from '../models/config.models';
import {
  CropRect,
  Customization,
  CustomizationArea,
  FieldValue,
  ImageValue,
  QuarterTurns,
  TextValue,
} from '../models/draft.models';
import {
  PRODUCT_SCHEMA_VERSION,
  ProductConfig,
  SourceSchemaVersion,
} from '../models/product.models';
import { checkCrop } from './crop-math';
import { priceSnapshot } from './price';
import { ActiveField, ResolvedProduct, artworkByArea } from './resolve';
import { normalizeText } from './text-utils';
import {
  DraftValues,
  defaultValue,
  defaultValuesFor,
  isArtworkValue,
  isImageValue,
  isTextValue,
} from './values';

export {
  defaultValue,
  isArtworkValue,
  isImageValue,
  isTextValue,
  stableKey,
  type DraftValues,
} from './values';

export function defaultValues(config: ProductConfig): DraftValues {
  return defaultValuesFor(config.fields);
}

/** Everything the shopper has chosen; the customization is derived from it. */
export interface DraftState {
  variantId: string;
  /** Printable area id -> artwork id (explicit choices only). */
  artworkSelection: Readonly<Record<string, string>>;
  values: DraftValues;
}

function serialiseValue(field: FieldSpec, value: FieldValue): FieldValue | null {
  if (field.type === 'text' && isTextValue(value)) {
    const out: TextValue = {
      text: normalizeText(value.text),
      fontId: value.fontId,
      color: value.color,
    };
    if (value.bold !== undefined) out.bold = value.bold;
    if (value.italic !== undefined) out.italic = value.italic;
    if (value.underline !== undefined) out.underline = value.underline;
    if (value.align !== undefined) out.align = value.align;
    return out;
  }
  if (field.type === 'image' && isImageValue(value)) {
    const out: ImageValue = {
      assetId: value.assetId,
      crop: value.crop ? ([...value.crop] as unknown as CropRect) : null,
    };
    if (value.fit !== undefined) out.fit = value.fit;
    if (value.rotation) out.rotation = value.rotation;
    return out;
  }
  if (field.type === 'artwork' && isArtworkValue(value)) return { choiceId: value.choiceId };
  return null;
}

/**
 * The saved design. A version-1 source keeps emitting the version-1 shape (single canvas, every
 * field); a version-2 source emits only the fields that are active for the chosen variant/artwork.
 */
export function buildCustomization(
  config: ProductConfig,
  source: SourceSchemaVersion,
  resolved: ResolvedProduct,
  active: readonly ActiveField[],
  state: DraftState,
): Customization {
  if (source === 1) {
    const area = config.printableAreas[0];
    const values: DraftValues = {};
    for (const field of config.fields) {
      const serialised = serialiseValue(field, state.values[field.id] ?? defaultValue(field));
      if (serialised) values[field.id] = serialised;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      productId: config.product.id,
      ...(config.product.variantId ? { variantId: config.product.variantId } : {}),
      templateId: config.id,
      templateVersion: config.version,
      values,
      canvas: { ...area.canvas },
      ...(area.print
        ? { print: { widthMm: area.print.widthMm, heightMm: area.print.heightMm } }
        : {}),
      ...(config.displayPrice ? { displayPrice: priceSnapshot(config.displayPrice) } : {}),
    };
  }

  const values: DraftValues = {};
  for (const { field } of active) {
    const serialised = serialiseValue(field, state.values[field.id] ?? defaultValue(field));
    if (serialised) values[field.id] = serialised;
  }
  const areas: Record<string, CustomizationArea> = {};
  for (const { area, artwork } of resolved.areas) {
    areas[area.id] = {
      artworkId: artwork?.id ?? null,
      canvas: { width: area.canvas.width, height: area.canvas.height },
    };
  }
  return {
    schemaVersion: PRODUCT_SCHEMA_VERSION,
    productId: config.product.id,
    configId: config.id,
    configVersion: config.version,
    variantId: resolved.variant.id,
    artworkSelection: artworkByArea(resolved),
    values,
    areas,
    ...(config.displayPrice ? { displayPrice: priceSnapshot(config.displayPrice) } : {}),
  };
}

export type ParseResult =
  | {
      ok: true;
      values: DraftValues;
      variantId: string | null;
      artworkSelection: Record<string, string>;
    }
  | { ok: false; message: string };

const fail = (message: string): ParseResult => ({ ok: false, message });

/**
 * Validate a host-supplied `initialCustomization` against the loaded configuration. Missing
 * fields fall back to template defaults; anything that doesn't match rejects the whole draft.
 * Crop aspect ratios are checked later, once the image dimensions are known.
 */
export function parseCustomization(
  raw: unknown,
  config: ProductConfig,
  source: SourceSchemaVersion,
): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return fail('initialCustomization must be an object');
  const o = raw as Record<string, unknown>;
  const expected = source === 1 ? SCHEMA_VERSION : PRODUCT_SCHEMA_VERSION;
  if (o['schemaVersion'] !== expected)
    return fail('initialCustomization has an unsupported schemaVersion');
  if (o['productId'] !== config.product.id)
    return fail('initialCustomization is for a different product');

  let variantId: string | null = null;
  const artworkSelection: Record<string, string> = {};
  if (source === 1) {
    if (o['templateId'] !== config.id)
      return fail('initialCustomization is for a different template');
    if (o['templateVersion'] !== config.version)
      return fail('initialCustomization was saved with a different template version');
  } else {
    if (o['configId'] !== config.id)
      return fail('initialCustomization is for a different configuration');
    if (o['configVersion'] !== config.version)
      return fail('initialCustomization was saved with a different configuration version');
    if (typeof o['variantId'] !== 'string' || !config.variants.some((v) => v.id === o['variantId']))
      return fail('initialCustomization names an unknown variant');
    variantId = o['variantId'];
    const selection = o['artworkSelection'];
    if (typeof selection !== 'object' || selection === null || Array.isArray(selection))
      return fail('initialCustomization.artworkSelection must be an object');
    for (const [areaId, artworkId] of Object.entries(selection)) {
      const area = config.printableAreas.find((a) => a.id === areaId);
      if (!area || typeof artworkId !== 'string' || !area.artworkIds.includes(artworkId))
        return fail(`initialCustomization selects an unknown artwork for area "${areaId}"`);
      artworkSelection[areaId] = artworkId;
    }
  }

  const rawValues = o['values'];
  if (typeof rawValues !== 'object' || rawValues === null || Array.isArray(rawValues)) {
    return fail('initialCustomization.values must be an object');
  }
  const input = rawValues as Record<string, unknown>;
  const known = new Set(config.fields.map((f) => f.id));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) return fail(`initialCustomization has a value for unknown field "${key}"`);
  }

  const values: DraftValues = {};
  for (const field of config.fields) {
    const entry = input[field.id];
    if (entry === undefined) {
      values[field.id] = defaultValue(field);
      continue;
    }
    const parsed = parseValue(field, entry);
    if (typeof parsed === 'string') return fail(parsed);
    values[field.id] = parsed;
  }
  return { ok: true, values, variantId, artworkSelection };
}

/** A parsed value, or a message describing why `entry` is not a valid value for `field`. */
function parseValue(field: FieldSpec, entry: unknown): FieldValue | string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `value for "${field.id}" must be an object`;
  }
  const v = entry as Record<string, unknown>;
  switch (field.type) {
    case 'text': {
      if (typeof v['text'] !== 'string') return `"${field.id}".text must be a string`;
      if (typeof v['fontId'] !== 'string' || !field.fontIds.includes(v['fontId'])) {
        return `"${field.id}".fontId is not an allowed font`;
      }
      if (typeof v['color'] !== 'string' || !field.colors.includes(v['color'])) {
        return `"${field.id}".color is not an allowed colour`;
      }
      const value: TextValue = {
        text: normalizeText(v['text']),
        fontId: v['fontId'],
        color: v['color'],
      };
      for (const flag of ['bold', 'italic', 'underline'] as const) {
        if (v[flag] === undefined) continue;
        if (typeof v[flag] !== 'boolean') return `"${field.id}".${flag} must be true or false`;
        value[flag] = v[flag];
      }
      if (v['align'] !== undefined) {
        if (v['align'] !== 'left' && v['align'] !== 'center' && v['align'] !== 'right')
          return `"${field.id}".align is not valid`;
        value.align = v['align'];
      }
      return value;
    }
    case 'image': {
      const assetId = v['assetId'] ?? null;
      if (
        assetId !== null &&
        (typeof assetId !== 'string' || assetId.length === 0 || assetId.length > 200)
      ) {
        return `"${field.id}".assetId must be a string or null`;
      }
      const crop = v['crop'] ?? null;
      if (crop !== null) {
        const check = checkCrop(crop, null, null, 1);
        if (!check.ok) return `"${field.id}".${check.reason}`;
      }
      if ((assetId === null) !== (crop === null))
        return `"${field.id}" needs both assetId and crop, or neither`;
      const value: ImageValue = { assetId, crop: crop as CropRect | null };
      if (v['fit'] !== undefined) {
        if (v['fit'] !== 'cover' && v['fit'] !== 'contain') return `"${field.id}".fit is not valid`;
        value.fit = v['fit'];
      }
      if (v['rotation'] !== undefined) {
        if (![0, 90, 180, 270].includes(v['rotation'] as number))
          return `"${field.id}".rotation must be 0, 90, 180 or 270`;
        value.rotation = v['rotation'] as QuarterTurns;
      }
      return value;
    }
    case 'artwork': {
      const choiceId = v['choiceId'] ?? null;
      if (choiceId !== null && !field.choices.some((choice) => choice.id === choiceId)) {
        return `"${field.id}".choiceId is not one of the choices`;
      }
      return { choiceId: choiceId as string | null };
    }
  }
}
