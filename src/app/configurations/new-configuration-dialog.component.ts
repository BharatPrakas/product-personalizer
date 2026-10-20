import { Component, inject, input, output, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ConfigurationRepository } from '../workspace/configuration-repository';
import { ImageUploadService } from '../workspace/image-upload.service';
import { DialogComponent } from '../ui/dialog.component';
import { IconComponent } from '../ui/icon.component';

/**
 * Starts a configuration: a name, and optionally the first product photo. Everything else (printable
 * areas, artwork, customer inputs) is added in the editor, which guides the merchant through it.
 */
@Component({
  selector: 'app-new-configuration-dialog',
  imports: [ReactiveFormsModule, DialogComponent, IconComponent],
  template: `
    <app-dialog
      [open]="open()"
      title="New configuration"
      description="Name the product to personalize. You can add the product photo now or later."
      (closed)="cancel()"
    >
      <form class="stack" (submit)="$event.preventDefault(); create()" id="new-config-form">
        <label class="field">
          <span class="field-label">Configuration name</span>
          <input
            class="input"
            type="text"
            autocomplete="off"
            placeholder="e.g. Heart-shaped photo clock"
            [formControl]="name"
            [attr.aria-invalid]="name.invalid && name.touched"
            [attr.aria-describedby]="name.invalid && name.touched ? 'name-error' : null"
          />
          @if (name.invalid && name.touched) {
            <span id="name-error" class="field-error">Enter a name for this configuration.</span>
          }
        </label>

        <div class="field">
          <span class="field-label">Product photo (optional)</span>
          @if (photoName(); as chosen) {
            <div class="row">
              <app-icon name="image" />
              <span class="grow truncate">{{ chosen }}</span>
              <button type="button" class="btn btn--sm" (click)="clearPhoto()">Remove</button>
            </div>
          } @else {
            <label class="btn btn--block">
              <app-icon name="upload" />
              <span>Choose an image…</span>
              <input
                class="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                (change)="onPhoto($event)"
              />
            </label>
          }
          <span class="field-hint">PNG, JPEG or WebP up to 15 MB. It stays in this browser.</span>
          @if (photoError(); as message) {
            <span class="field-error" role="alert">{{ message }}</span>
          }
        </div>
      </form>
      <ng-container dialogActions>
        <button type="button" class="btn" (click)="cancel()">Cancel</button>
        <button type="submit" form="new-config-form" class="btn btn--primary" [disabled]="busy()">
          {{ busy() ? 'Creating…' : 'Create configuration' }}
        </button>
      </ng-container>
    </app-dialog>
  `,
})
export class NewConfigurationDialogComponent {
  private readonly repo = inject(ConfigurationRepository);
  private readonly uploads = inject(ImageUploadService);

  readonly open = input(false);
  readonly closed = output<void>();
  readonly created = output<string>();

  protected readonly name = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.pattern(/\S/)],
  });
  protected readonly photoName = signal<string | null>(null);
  protected readonly photoError = signal<string | null>(null);
  protected readonly busy = signal(false);
  private photo: File | null = null;

  protected onPhoto(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    this.photoError.set(null);
    if (!file) return;
    this.photo = file;
    this.photoName.set(file.name);
  }

  protected clearPhoto(): void {
    this.photo = null;
    this.photoName.set(null);
    this.photoError.set(null);
  }

  protected cancel(): void {
    this.reset();
    this.closed.emit();
  }

  protected async create(): Promise<void> {
    this.name.markAsTouched();
    if (this.name.invalid || this.busy()) return;
    this.busy.set(true);
    try {
      let mockupSrc: string | undefined;
      if (this.photo) {
        const stored = await this.uploads.store(this.photo);
        if (!stored.ok) {
          this.photoError.set(stored.message);
          return;
        }
        mockupSrc = stored.src;
      }
      const record = await this.repo.create({
        name: this.name.value,
        mockupSrc,
        mockupName: this.photo ? 'Front view' : undefined,
      });
      this.reset();
      this.created.emit(record.id);
    } catch {
      this.photoError.set('The configuration could not be created. Please try again.');
    } finally {
      this.busy.set(false);
    }
  }

  private reset(): void {
    this.name.reset('');
    this.clearPhoto();
  }
}
