/** Field value helpers with no dependency on the resolved product (see `resolve.ts`). */

import type { FieldSpec } from '../models/config.models';
import type { ArtworkValue, FieldValue, ImageValue, TextValue } from '../models/draft.models';

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
    case 'text': {
      const d = field.defaultValue;
      return {
        text: d?.text ?? '',
        fontId: d?.fontId ?? field.fontIds[0],
        color: d?.color ?? field.colors[0],
        ...(d?.bold !== undefined ? { bold: d.bold } : {}),
        ...(d?.italic !== undefined ? { italic: d.italic } : {}),
        ...(d?.underline !== undefined ? { underline: d.underline } : {}),
        ...(d?.align !== undefined ? { align: d.align } : {}),
      };
    }
    case 'image':
      return { assetId: null, crop: null };
    case 'artwork':
      return { choiceId: field.defaultChoiceId ?? null };
  }
}

export function defaultValuesFor(fields: readonly FieldSpec[]): DraftValues {
  return Object.fromEntries(fields.map((field) => [field.id, defaultValue(field)]));
}

/** Key-order independent serialisation used for dirty checks and change de-duplication. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
