/** Building, restoring and comparing the serialisable draft. Pure functions. */

import { CustomizerConfig, FieldSpec, SCHEMA_VERSION } from '../models/config.models';
import {
  ArtworkValue,
  CropRect,
  Customization,
  FieldValue,
  ImageValue,
  TextValue,
} from '../models/draft.models';
import { checkCrop } from './crop-math';
import { normalizeText } from './text-utils';
import { priceSnapshot } from './price';

export type DraftValues = Record<string, FieldValue>;

export function isTextValue(value: FieldValue | undefined): value is TextValue {
  return !!value && 'text' in value;
}

export function isImageValue(value: FieldValue | undefined): value is ImageValue {
  return !!value && 'assetId' in value;
}

export function isArtworkValue(value: FieldValue | undefined): value is ArtworkValue {
  return !!value && 'choiceId' in value;
}

export function defaultValue(field: FieldSpec): FieldValue {
  switch (field.type) {
    case 'text':
      return {
        text: field.defaultValue?.text ?? '',
        fontId: field.defaultValue?.fontId ?? field.fontIds[0],
        color: field.defaultValue?.color ?? field.colors[0],
      };
    case 'image':
      return { assetId: null, crop: null };
    case 'artwork':
      return { choiceId: field.defaultChoiceId ?? null };
  }
}

export function defaultValues(config: CustomizerConfig): DraftValues {
  return Object.fromEntries(config.fields.map((field) => [field.id, defaultValue(field)]));
}

/** Key-order independent serialisation used for dirty checks and change de-duplication. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function buildCustomization(config: CustomizerConfig, values: DraftValues): Customization {
  const out: DraftValues = {};
  for (const field of config.fields) {
    const value = values[field.id] ?? defaultValue(field);
    if (field.type === 'text' && isTextValue(value)) {
      out[field.id] = { text: normalizeText(value.text), fontId: value.fontId, color: value.color };
    } else if (field.type === 'image' && isImageValue(value)) {
      out[field.id] = {
        assetId: value.assetId,
        crop: value.crop ? ([...value.crop] as unknown as CropRect) : null,
      };
    } else if (field.type === 'artwork' && isArtworkValue(value)) {
      out[field.id] = { choiceId: value.choiceId };
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    productId: config.product.id,
    ...(config.product.variantId ? { variantId: config.product.variantId } : {}),
    templateId: config.templateId,
    templateVersion: config.templateVersion,
    values: out,
    canvas: { ...config.canvas },
    ...(config.print
      ? { print: { widthMm: config.print.widthMm, heightMm: config.print.heightMm } }
      : {}),
    ...(config.displayPrice ? { displayPrice: priceSnapshot(config.displayPrice) } : {}),
  };
}

export type ParseResult = { ok: true; values: DraftValues } | { ok: false; message: string };

const fail = (message: string): ParseResult => ({ ok: false, message });

/**
 * Validate a host-supplied `initialCustomization` against the loaded configuration. Missing
 * fields fall back to template defaults; anything that doesn't match rejects the whole draft.
 * Crop aspect ratios are checked later, once the image dimensions are known.
 */
export function parseCustomization(raw: unknown, config: CustomizerConfig): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return fail('initialCustomization must be an object');
  const o = raw as Record<string, unknown>;
  if (o['schemaVersion'] !== SCHEMA_VERSION)
    return fail('initialCustomization has an unsupported schemaVersion');
  if (o['productId'] !== config.product.id)
    return fail('initialCustomization is for a different product');
  if (o['templateId'] !== config.templateId)
    return fail('initialCustomization is for a different template');
  if (o['templateVersion'] !== config.templateVersion) {
    return fail('initialCustomization was saved with a different template version');
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
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return fail(`value for "${field.id}" must be an object`);
    }
    const v = entry as Record<string, unknown>;
    switch (field.type) {
      case 'text': {
        if (typeof v['text'] !== 'string') return fail(`"${field.id}".text must be a string`);
        if (typeof v['fontId'] !== 'string' || !field.fontIds.includes(v['fontId'])) {
          return fail(`"${field.id}".fontId is not an allowed font`);
        }
        if (typeof v['color'] !== 'string' || !field.colors.includes(v['color'])) {
          return fail(`"${field.id}".color is not an allowed colour`);
        }
        values[field.id] = {
          text: normalizeText(v['text']),
          fontId: v['fontId'],
          color: v['color'],
        };
        break;
      }
      case 'image': {
        const assetId = v['assetId'] ?? null;
        if (
          assetId !== null &&
          (typeof assetId !== 'string' || assetId.length === 0 || assetId.length > 200)
        ) {
          return fail(`"${field.id}".assetId must be a string or null`);
        }
        const crop = v['crop'] ?? null;
        if (crop !== null) {
          const check = checkCrop(crop, null, null, 1);
          if (!check.ok) return fail(`"${field.id}".${check.reason}`);
        }
        if ((assetId === null) !== (crop === null))
          return fail(`"${field.id}" needs both assetId and crop, or neither`);
        values[field.id] = { assetId, crop: crop as CropRect | null };
        break;
      }
      case 'artwork': {
        const choiceId = v['choiceId'] ?? null;
        if (choiceId !== null && !field.choices.some((choice) => choice.id === choiceId)) {
          return fail(`"${field.id}".choiceId is not one of the choices`);
        }
        values[field.id] = { choiceId: choiceId as string | null };
        break;
      }
    }
  }
  return { ok: true, values };
}
