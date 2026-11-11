import { Component, DestroyRef, ElementRef, effect, inject, input, signal, untracked } from '@angular/core';
import { TranslatePipe } from '../admin/i18n/i18n.service';
import { IconComponent } from '../ui/icon.component';
import { OrderFileMissingError } from './order.models';
import { OrderRepository } from './order-repository';

type State = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

/**
 * A private customer image. It is fetched through the authenticated API only once it scrolls into
 * view (so a large order never preloads every file) and shown from an object URL that is released
 * with the component. A blob URL cannot use `NgOptimizedImage`, hence a plain `<img>`.
 */
@Component({
  selector: 'app-auth-image',
  imports: [IconComponent, TranslatePipe],
  host: { class: 'auth-image', '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `
    @switch (state()) {
      @case ('ready') {
        <img [src]="url()" [alt]="alt()" [width]="size()" [height]="size()" />
      }
      @case ('missing') {
        <span class="auth-image__note"><app-icon name="alert" [size]="16" />{{ 'orders.file.unavailable' | t }}</span>
      }
      @case ('error') {
        <span class="auth-image__note"><app-icon name="alert" [size]="16" />{{ 'orders.file.error' | t }}</span>
      }
      @default {
        <span class="sr-only">{{ 'common.loading' | t }}</span>
      }
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: var(--r-sm);
      background: var(--c-surface-muted);
      border: 1px solid var(--c-border);
      flex: none;
    }
    img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .auth-image__note {
      display: inline-flex; flex-direction: column; align-items: center; gap: var(--s-1);
      padding: var(--s-1); font-size: var(--fs-xs); color: var(--c-text-muted); text-align: center;
    }
  `,
})
export class AuthImageComponent {
  readonly customizationId = input.required<string>();
  /** `null`: the design references a file that is no longer stored. */
  readonly assetId = input.required<string | null>();
  readonly alt = input('');
  readonly size = input(64);

  private readonly orders = inject(OrderRepository);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly state = signal<State>('idle');
  protected readonly url = signal<string | null>(null);
  private visible = false;
  private abort: AbortController | null = null;

  constructor() {
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) {
                this.visible = true;
                observer?.disconnect();
                void this.load();
              }
            },
            { rootMargin: '200px' },
          );
    if (observer) observer.observe(this.element.nativeElement);
    else this.visible = true;

    effect(() => {
      this.customizationId();
      this.assetId();
      untracked(() => {
        this.release();
        this.state.set('idle');
        if (this.visible) void this.load();
      });
    });

    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      this.release();
    });
  }

  private async load(): Promise<void> {
    const assetId = this.assetId();
    if (assetId === null) {
      this.state.set('missing');
      return;
    }
    if (this.state() !== 'idle') return;
    this.state.set('loading');
    const controller = new AbortController();
    this.abort = controller;
    try {
      const blob = await this.orders.file(this.customizationId(), assetId, controller.signal);
      if (controller.signal.aborted) return;
      this.url.set(URL.createObjectURL(blob));
      this.state.set('ready');
    } catch (error) {
      if (controller.signal.aborted) return;
      this.state.set(error instanceof OrderFileMissingError ? 'missing' : 'error');
    }
  }

  private release(): void {
    this.abort?.abort();
    this.abort = null;
    const url = this.url();
    if (url) URL.revokeObjectURL(url);
    this.url.set(null);
  }
}
