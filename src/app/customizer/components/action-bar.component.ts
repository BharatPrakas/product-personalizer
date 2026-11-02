import {
  Component,
  ElementRef,
  Injector,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  afterNextRender,
} from '@angular/core';
import { SaveState } from '../services/save-coordinator.service';

export interface PriceView {
  total: string;
  base: string;
  fee: string;
}

/** Price, blocker summary, save status, Save and Reset (with inline confirmation). */
@Component({
  selector: 'app-action-bar',
  template: `
    @if (price(); as p) {
      <div class="price" aria-label="Display price">
        <span class="price-total">{{ p.total }}</span>
        <span class="price-note">
          {{ p.base }} + {{ p.fee }} personalization. Indicative price supplied by the store; the
          final price is confirmed at checkout.
        </span>
      </div>
    }

    @if (blockers().length > 0) {
      <div class="blockers">
        <p class="blockers-title">{{ blockersTitle() }}</p>
        <ul>
          @for (blocker of blockers(); track blocker) {
            <li>{{ blocker }}</li>
          }
        </ul>
      </div>
    }

    @if (confirming()) {
      <div class="confirm" role="group" aria-labelledby="confirm-title">
        <p id="confirm-title" class="confirm-title">
          Reset everything to the starting design? Your text and photos will be removed.
        </p>
        <div class="btn-row">
          <button type="button" class="btn danger" #confirmButton (click)="confirmReset()">
            Yes, reset
          </button>
          <button type="button" class="btn secondary" (click)="cancelReset()">Keep editing</button>
        </div>
      </div>
    }

    <div class="action-row">
      <div class="status" role="status" aria-live="polite">
        @if (statusText(); as text) {
          <p [class.status-error]="isError()" [class.status-ok]="state() === 'saved'">{{ text }}</p>
        }
      </div>
      <div class="btn-row">
        @if (showSave()) {
          <button
            type="button"
            class="btn primary"
            part="primary-button"
            [disabled]="saveDisabled()"
            (click)="save.emit()"
          >
            {{ saveLabel() }}
          </button>
        }
        <button
          type="button"
          class="btn secondary"
          #resetButton
          [attr.aria-disabled]="resetDisabled()"
          (click)="askReset()"
        >
          Reset
        </button>
      </div>
    </div>
  `,
})
export class ActionBarComponent {
  private readonly injector = inject(Injector);

  readonly price = input<PriceView | null>(null);
  readonly blockers = input<readonly string[]>([]);
  readonly state = input.required<SaveState>();
  readonly message = input<string | null>(null);
  readonly saveDisabled = input.required<boolean>();
  readonly resetDisabled = input.required<boolean>();
  /** False when the host page owns the primary action (Add to cart), so no second Save button is shown. */
  readonly showSave = input(true);
  readonly blockersTitle = input('Before you can save:');

  readonly save = output<void>();
  readonly reset = output<void>();

  protected readonly confirming = signal(false);
  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly resetButton = viewChild<ElementRef<HTMLButtonElement>>('resetButton');

  protected readonly saveLabel = computed(() => {
    switch (this.state()) {
      case 'exporting':
        return 'Preparing…';
      case 'awaiting-host':
        return 'Saving…';
      case 'no-response':
        return 'Retry';
      default:
        return 'Save customization';
    }
  });

  protected readonly isError = computed(() =>
    ['host-error', 'export-error', 'no-response'].includes(this.state()),
  );

  protected readonly statusText = computed(() => {
    switch (this.state()) {
      case 'exporting':
        return 'Preparing your design…';
      case 'awaiting-host':
        return 'Waiting for the store to confirm…';
      case 'no-response':
        return 'No response yet. Retry to send the same request again.';
      case 'saved':
        return this.message();
      case 'host-error':
        return `Could not save. ${this.message() ?? ''}`.trim();
      case 'export-error':
        return `Could not prepare your design. ${this.message() ?? ''}`.trim();
      default:
        return null;
    }
  });

  protected askReset(): void {
    // aria-disabled (not `disabled`) keeps the button focusable so focus isn't lost after a reset.
    if (this.resetDisabled()) return;
    this.confirming.set(true);
    afterNextRender(() => this.confirmButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected confirmReset(): void {
    this.confirming.set(false);
    this.reset.emit();
    afterNextRender(() => this.resetButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancelReset(): void {
    this.confirming.set(false);
    afterNextRender(() => this.resetButton()?.nativeElement.focus(), { injector: this.injector });
  }
}
