import { Service, computed, inject, signal } from '@angular/core';
import { I18n } from '../admin/i18n/i18n.service';
import { addFont, removeFont } from '../editor/util/config-edit';
import { EditorStore } from '../editor/services/editor-store.service';
import { ToastService } from '../ui/toast.service';
import { FontRepository } from './font-repository';
import { FontFileInvalidError, FontLabelInvalidError, FontLibraryUnavailableOfflineError, type CustomFont } from './font.models';

/** A font the template already has, whether bundled or custom. */
const inTemplate = (config: { fonts: readonly { id: string }[] } | null, id: string): boolean =>
  !!config?.fonts.some((f) => f.id === id);

/**
 * The custom font library as the editor uses it: list the store's uploaded fonts, upload / delete
 * one, and add / remove one to / from the template being edited. Provided per editor page because
 * it edits through that page's `EditorStore`, exactly like `MarkupLibrary`.
 */
@Service({ autoProvided: false })
export class FontLibrary {
  private readonly store = inject(EditorStore);
  private readonly repo = inject(FontRepository);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(I18n);

  readonly items = signal<readonly CustomFont[]>([]);
  readonly state = signal<'idle' | 'loading' | 'error'>('idle');
  readonly uploading = signal(false);

  /** Ids of the template's fonts (bundled + custom) that are currently in use, for the UI to check. */
  readonly templateFontIds = computed(() => new Set((this.store.config()?.fonts ?? []).map((f) => f.id)));

  async refresh(): Promise<void> {
    this.state.set('loading');
    try {
      this.items.set(await this.repo.list());
      this.state.set('idle');
    } catch (error) {
      this.state.set(error instanceof FontLibraryUnavailableOfflineError ? 'idle' : 'error');
    }
  }

  usedInTemplate(font: CustomFont): boolean {
    return inTemplate(this.store.config(), font.id);
  }

  /** Uploads a new custom font to the store library and immediately adds it to the open template. */
  async upload(blob: Blob, label: string): Promise<void> {
    this.uploading.set(true);
    try {
      const font = await this.repo.upload({ blob, label, filename: blob instanceof File ? blob.name : undefined });
      this.items.update((items) => [font, ...items]);
      this.addToTemplate(font);
      this.toasts.success(this.i18n.t('fonts.uploaded', { name: font.label }));
    } catch (error) {
      if (error instanceof FontLabelInvalidError || error instanceof FontFileInvalidError) throw error;
      if (error instanceof FontLibraryUnavailableOfflineError) {
        this.toasts.error(error.message);
        throw error;
      }
      this.toasts.error(this.i18n.t('fonts.error.upload'));
      throw error;
    } finally {
      this.uploading.set(false);
    }
  }

  addToTemplate(font: CustomFont): void {
    if (inTemplate(this.store.config(), font.id)) return;
    this.store.edit((config) =>
      addFont(config, { id: font.id, family: font.label, label: font.label, src: font.deliveryUrl }).config,
    );
  }

  removeFromTemplate(font: CustomFont): void {
    this.store.edit((config) => removeFont(config, font.id));
  }

  /** Deletes the font from the store library (refused by the Worker while any saved template uses it) and the open draft. */
  async remove(font: CustomFont): Promise<void> {
    try {
      await this.repo.delete(font.id);
    } catch (error) {
      this.toasts.error(this.i18n.t('fonts.error.delete'));
      throw error;
    }
    this.removeFromTemplate(font);
    this.items.update((items) => items.filter((f) => f.id !== font.id));
    this.toasts.success(this.i18n.t('fonts.deleted', { name: font.label }));
  }
}
