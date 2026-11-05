import type { CustomFont } from './font.models';

/** Where the custom font library lives: the personalization API (per store), or nowhere (offline). */
export abstract class FontRepository {
  abstract list(): Promise<CustomFont[]>;
  /** Rejects with `FontLabelInvalidError` / `FontFileInvalidError` for the dialog to show. */
  abstract upload(input: { blob: Blob; label: string; filename?: string }): Promise<CustomFont>;
  /** Rejects with `ApiClientError` (409) when the font is still used by a saved template/version. */
  abstract delete(id: string): Promise<void>;
}
