import { Service, inject, signal } from '@angular/core';
import { I18n } from '../admin/i18n/i18n.service';
import type { PrintableArea } from '../customizer/models/product.models';
import { EditorStore } from '../editor/services/editor-store.service';
import { ToastService } from '../ui/toast.service';
import { validateConfiguration } from '../workspace/validation';
import {
  areaToMarkup,
  artworkToMarkup,
  insertAreaMarkup,
  insertArtworkMarkup,
} from './markup-edit';
import {
  Markup,
  MarkupInvalidError,
  MarkupKind,
  MarkupPayload,
  parsePayload,
} from './markup.models';
import { MarkupRepository } from './markup-repository';

export interface SaveRequest {
  kind: MarkupKind;
  payload: MarkupPayload;
  suggestedName: string;
}

/**
 * The markup library as the editor uses it: capture the selected area / artwork, list and search
 * the library, insert a markup into the template being edited. Provided per editor page because
 * it edits through that page's `EditorStore`.
 */
@Service({ autoProvided: false })
export class MarkupLibrary {
  private readonly store = inject(EditorStore);
  private readonly repo = inject(MarkupRepository);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(I18n);

  readonly saveRequest = signal<SaveRequest | null>(null);
  readonly items = signal<readonly Markup[]>([]);
  readonly state = signal<'idle' | 'loading' | 'error'>('idle');

  async refresh(query: { kind?: MarkupKind; search?: string } = {}): Promise<void> {
    this.state.set('loading');
    try {
      this.items.set(await this.repo.list(query));
      this.state.set('idle');
    } catch {
      this.state.set('error');
    }
  }

  // ---- capture -----------------------------------------------------------------------------

  requestSaveArea(area: PrintableArea): void {
    const config = this.store.config();
    const payload = config ? areaToMarkup(config, area.id) : null;
    if (payload) this.saveRequest.set({ kind: 'area', payload, suggestedName: area.name });
  }

  requestSaveArtwork(artworkId: string): void {
    const config = this.store.config();
    const payload = config ? artworkToMarkup(config, artworkId) : null;
    if (payload)
      this.saveRequest.set({ kind: 'artwork', payload, suggestedName: payload.artwork.name });
  }

  /** Throws `MarkupNameTakenError` / `MarkupInvalidError` for the dialog to show. */
  async save(name: string): Promise<void> {
    const request = this.saveRequest();
    if (!request) return;
    await this.repo.create({ name, kind: request.kind, payload: request.payload });
    this.saveRequest.set(null);
    this.toasts.success(this.i18n.t('markups.saved'));
  }

  // ---- insert ------------------------------------------------------------------------------

  insert(markup: Markup): void {
    const config = this.store.config();
    if (!config) return;
    let payload: MarkupPayload;
    try {
      payload = parsePayload(markup.payload, markup.kind);
    } catch (error) {
      this.toasts.error(
        error instanceof MarkupInvalidError ? error.message : this.i18n.t('markups.error'),
      );
      return;
    }

    if (payload.kind === 'area') {
      const result = insertAreaMarkup(config, payload, { name: markup.name });
      if (!this.valid(result.config)) return;
      this.store.edit(() => result.config);
      this.store.select({ kind: 'area', id: result.areaId });
      this.toasts.success(this.i18n.t('markups.inserted', { name: markup.name }));
      return;
    }

    const areaId = this.targetAreaId();
    if (!areaId) {
      this.toasts.error(this.i18n.t('markups.insert-needs-area'));
      return;
    }
    const result = insertArtworkMarkup(config, areaId, payload, { name: markup.name });
    if (!result || !this.valid(result.config)) return;
    this.store.edit(() => result.config);
    this.store.select({ kind: 'artwork', id: result.artworkId });
    this.toasts.success(this.i18n.t('markups.inserted', { name: markup.name }));
    if (result.warnings.includes('fonts'))
      this.toasts.show('info', this.i18n.t('markups.warning.fonts'));
  }

  /** The area an artwork is inserted into: the selected area, or the area of the selected artwork. */
  private targetAreaId(): string | null {
    const selection = this.store.selection();
    const config = this.store.config();
    if (selection.kind === 'area') return selection.id;
    if (selection.kind === 'artwork')
      return config?.artworks.find((a) => a.id === selection.id)?.printableAreaId ?? null;
    return this.store.area()?.id ?? null;
  }

  /** A markup must never make the template invalid; refuse and say so. */
  private valid(config: unknown): boolean {
    if (validateConfiguration(config, { allowIncomplete: true }).ok) return true;
    this.toasts.error(this.i18n.t('markups.error'));
    return false;
  }

  // ---- manage ------------------------------------------------------------------------------

  async rename(markup: Markup, name: string): Promise<void> {
    await this.repo.rename(markup.id, name);
    this.toasts.success(this.i18n.t('markups.renamed'));
  }

  async remove(markup: Markup): Promise<void> {
    await this.repo.delete(markup.id);
    this.toasts.success(this.i18n.t('markups.deleted'));
  }
}
