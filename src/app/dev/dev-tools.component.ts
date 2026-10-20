import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { dbClear } from '../customizer/services/local-db';
import { ConfirmService } from '../ui/confirm.service';
import { ToastService } from '../ui/toast.service';
import { ConfigurationRepository } from '../workspace/configuration-repository';
import { ConfigurationTransferService } from '../workspace/configuration-transfer.service';

interface Fixture {
  file: string;
  name: string;
  busy: boolean;
}

/**
 * Development builds only (the route is guarded by `isDevMode()`): load the bundled sample
 * configurations into the workspace, open the custom-element contract demo, or wipe local data.
 * Nothing here runs automatically; the normal workspace never contains sample products unless
 * a developer adds them on purpose.
 */
@Component({
  selector: 'app-dev-tools',
  imports: [RouterLink],
  template: `
    <section class="page" aria-labelledby="dev-title">
      <header class="page-header">
        <div>
          <h1 id="dev-title">Developer tools</h1>
          <p class="muted">
            Available in development builds only. Not part of the merchant experience.
          </p>
        </div>
        <a class="btn" routerLink="/configurations">Back to configurations</a>
      </header>

      <section class="card stack" aria-labelledby="fixtures-title">
        <h2 id="fixtures-title">Sample configurations</h2>
        <p class="muted small">
          Fixtures from <code>public/data/products</code>. Adding one creates a new draft you can
          edit and delete.
        </p>
        @if (loadError(); as message) {
          <p class="field-error" role="alert">{{ message }}</p>
        }
        <ul class="plain-list">
          @for (f of fixtures(); track f.file) {
            <li class="list-row-simple">
              <span>{{ f.name }}</span>
              <button type="button" class="btn btn--sm" [disabled]="f.busy" (click)="add(f)">
                {{ f.busy ? 'Adding…' : 'Add to workspace' }}
              </button>
            </li>
          }
        </ul>
      </section>

      <section class="card stack" aria-labelledby="element-title">
        <h2 id="element-title">Custom element contract</h2>
        <p class="muted small">
          Loads configurations by URL through the same inputs and events a host page uses with
          <code>&lt;zb-product-customizer&gt;</code>.
        </p>
        <div class="row"><a class="btn" routerLink="/dev/element">Open the element demo</a></div>
      </section>

      <section class="card stack" aria-labelledby="reset-title">
        <h2 id="reset-title">Local data</h2>
        <p class="muted small">
          Deletes every configuration, uploaded image and saved customer design in this browser.
        </p>
        <div class="row">
          <button type="button" class="btn btn--danger" (click)="clearAll()">
            Clear all local data…
          </button>
        </div>
      </section>
    </section>
  `,
})
export class DevToolsComponent {
  private readonly repo = inject(ConfigurationRepository);
  private readonly transfer = inject(ConfigurationTransferService);
  private readonly confirmService = inject(ConfirmService);
  private readonly toasts = inject(ToastService);

  protected readonly fixtures = signal<Fixture[]>([]);
  protected readonly loadError = signal<string | null>(null);

  constructor() {
    void this.loadIndex();
  }

  private async loadIndex(): Promise<void> {
    try {
      const response = await fetch(new URL('data/products/index.json', document.baseURI));
      const files = (await response.json()) as string[];
      this.fixtures.set(
        files.map((file) => ({
          file,
          name: file.replace(/\.json$/, '').replace(/-/g, ' '),
          busy: false,
        })),
      );
    } catch {
      this.loadError.set('The fixture list could not be loaded.');
    }
  }

  protected async add(fixture: Fixture): Promise<void> {
    this.patch(fixture, true);
    try {
      const response = await fetch(new URL(`data/products/${fixture.file}`, document.baseURI));
      const raw = (await response.json()) as Record<string, unknown>;
      // Fixtures are written for `configUrl` use; stored copies resolve assets from the app root.
      raw['assetBaseUrl'] = 'assets/';
      const result = await this.transfer.parseImport(JSON.stringify(raw));
      if (!result.ok) throw new Error(result.issues[0]?.message ?? 'invalid fixture');
      const record = await this.repo.createFromDraft(result.draft);
      this.toasts.success(`Added “${record.draft.product.name}” as a draft.`);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'The fixture could not be added.');
    } finally {
      this.patch(fixture, false);
    }
  }

  private patch(fixture: Fixture, busy: boolean): void {
    this.fixtures.update((list) => list.map((f) => (f.file === fixture.file ? { ...f, busy } : f)));
  }

  protected async clearAll(): Promise<void> {
    const ok = await this.confirmService.confirm({
      title: 'Clear all local data?',
      message:
        'Every configuration, uploaded image and saved customer design in this browser is deleted.',
      confirmLabel: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    try {
      await Promise.all((['configs', 'assets', 'drafts'] as const).map((store) => dbClear(store)));
      this.toasts.success('Local data cleared.');
    } catch {
      this.toasts.error('The local data could not be cleared.');
    }
  }
}
