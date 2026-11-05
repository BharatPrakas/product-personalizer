/**
 * A store's custom-uploaded font (a `personalization.assets` row whose content is a font file, not
 * an image): the CLOUD-ONLY, store-wide library a merchant builds up and reuses across templates.
 * The bundled default fonts are NOT part of this library — they ship with the element itself (see
 * workspace/empty-configuration.ts) and are always available with no upload or management needed.
 */
export interface CustomFont {
  id: string;
  /** The name shown in the library and, once added to a template, the font picker. */
  label: string;
  contentType: string;
  sizeBytes: number;
  createdAt: number;
  /** Stable delivery URL — what gets written into the template's `fonts[].src` once added. */
  deliveryUrl: string;
}

export const MAX_FONT_LABEL_LENGTH = 80;
export const MAX_FONT_BYTES = 10 * 1024 * 1024;

export class FontLabelInvalidError extends Error {
  constructor(message = 'Give the font a name.') {
    super(message);
    this.name = 'FontLabelInvalidError';
  }
}

export class FontFileInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontFileInvalidError';
  }
}

/** The custom font library needs the cloud-backed API; the standalone / offline app has none. */
export class FontLibraryUnavailableOfflineError extends Error {
  constructor() {
    super('Custom fonts need the store backend. Connect this editor to a store to upload fonts.');
    this.name = 'FontLibraryUnavailableOfflineError';
  }
}

export function validateFontLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FONT_LABEL_LENGTH) throw new FontLabelInvalidError();
  return trimmed;
}
