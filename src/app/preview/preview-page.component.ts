import { Component, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ProductConfig } from '../customizer/models/product.models';
import { ConfigurationRepository } from '../workspace/configuration-repository';
import { EmptyStateComponent } from '../ui/empty-state.component';
import { CustomerPreviewComponent } from './customer-preview.component';

/** `/preview/:id`: the published version if there is one, otherwise (or with `?draft=1`) the saved draft. */
@Component({
  selector: 'app-preview-page',
  imports: [CustomerPreviewComponent, EmptyStateComponent, RouterLink],
  template: `
    @if (config(); as c) {
      <app-customer-preview
        [config]="c"
        [sourceLabel]="label()"
        backLabel="Configurations"
        (back)="close()"
      />
    } @else if (problem(); as message) {
      <div class="page">
        <app-empty-state icon="alert" title="Preview unavailable" [description]="message">
          <a class="btn btn--primary" routerLink="/configurations">Back to configurations</a>
        </app-empty-state>
      </div>
    } @else {
      <p class="page muted" role="status">Loading preview…</p>
    }
  `,
})
export class PreviewPageComponent {
  private readonly repo = inject(ConfigurationRepository);
  private readonly router = inject(Router);

  readonly id = input.required<string>();
  /** `?draft=1` previews the saved draft even when a published version exists. */
  readonly draft = input<string | undefined>();

  protected readonly config = signal<ProductConfig | null>(null);
  protected readonly label = signal('');
  protected readonly problem = signal<string | null>(null);

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
        this.problem.set('That configuration no longer exists.');
        return;
      }
      const published = !wantDraft ? record.published : null;
      const chosen = published ?? record.draft;
      this.label.set(published ? 'Published configuration' : 'Saved draft');
      this.config.set(chosen);
    } catch {
      this.problem.set('The configuration could not be read from this browser.');
    }
  }

  protected close(): void {
    void this.router.navigate(['/configurations']);
  }
}
