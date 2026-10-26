import { I18n, TranslatePipe } from '../admin/i18n/i18n.service';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { MessageKey } from '../admin/i18n/messages.en';
import { ProductConfig } from '../customizer/models/product.models';
import { ConfigurationRepository } from '../workspace/configuration-repository';
import { EmptyStateComponent } from '../ui/empty-state.component';
import { CustomerPreviewComponent } from './customer-preview.component';

/** `/preview/:id`: the published version if there is one, otherwise (or with `?draft=1`) the saved draft. */
@Component({
  selector: 'app-preview-page',
  imports: [CustomerPreviewComponent, EmptyStateComponent, RouterLink, TranslatePipe],
  template: `
    @if (config(); as c) {
      <app-customer-preview
        [config]="c"
        [sourceLabel]="label()"
        [backLabel]="'list.title' | t"
        (back)="close()"
      />
    } @else if (problem(); as message) {
      <div class="page">
        <app-empty-state
          icon="alert"
          [title]="'preview.unavailable' | t"
          [description]="message | t"
        >
          <a class="btn btn--primary" routerLink="/configurations">{{ 'editor.back' | t }}</a>
        </app-empty-state>
      </div>
    } @else {
      <p class="page muted" role="status">{{ 'preview.loading' | t }}</p>
    }
  `,
})
export class PreviewPageComponent {
  private readonly repo = inject(ConfigurationRepository);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);

  readonly id = input.required<string>();
  /** `?draft=1` previews the saved draft even when a published version exists. */
  readonly draft = input<string | undefined>();

  protected readonly config = signal<ProductConfig | null>(null);
  private readonly isPublished = signal(false);
  protected readonly label = computed(() =>
    this.i18n.t(this.isPublished() ? 'preview.published' : 'preview.saved-draft'),
  );
  protected readonly problem = signal<MessageKey | null>(null);

  constructor() {
    effect(() => {
      const id = this.id();
      const wantDraft = this.draft() !== undefined;
      this.config.set(null);
      this.problem.set(null);
      void this.load(id, wantDraft);
    });
  }

  private async load(id: string, wantDraft: boolean): Promise<void> {
    try {
      const record = await this.repo.get(id);
      if (!record) {
        this.problem.set('preview.error.missing');
        return;
      }
      const published = !wantDraft ? record.published : null;
      const chosen = published ?? record.draft;
      this.isPublished.set(!!published);
      this.config.set(chosen);
    } catch {
      this.problem.set('preview.error.read');
    }
  }

  protected close(): void {
    void this.router.navigate(['/configurations']);
  }
}
