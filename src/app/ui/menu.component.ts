import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent, IconName } from './icon.component';

/**
 * A button that opens a menu of actions. Items are projected `<button class="menu-item"
 * role="menuitem">` elements; choosing one closes the menu. Keyboard: Enter / Space / Down open,
 * Up / Down / Home / End move, Escape closes and returns focus, Tab leaves.
 */
@Component({
  selector: 'app-menu',
  imports: [IconComponent],
  host: { '(document:click)': 'onDocumentClick($event)', '(window:resize)': 'close()' },
  template: `
    <button
      #trigger
      type="button"
      class="btn"
      [class.btn--primary]="variant() === 'primary'"
      [class.btn--ghost]="variant() === 'ghost'"
      [class.btn--icon]="!text()"
      [attr.aria-label]="text() ? null : label()"
      [attr.data-tip]="text() ? null : label()"
      [attr.data-tip-align]="align() === 'end' ? 'end' : null"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [disabled]="disabled()"
      (click)="toggle()"
      (keydown)="onTriggerKey($event)"
    >
      @if (icon(); as name) {
        <app-icon [name]="name" />
      }
      @if (text(); as t) {
        <span>{{ t }}</span>
        <app-icon name="chevron-down" [size]="14" />
      }
    </button>
    @if (open()) {
      <div
        #panel
        class="menu"
        role="menu"
        [attr.aria-label]="label()"
        (click)="onPanelClick($event)"
        (keydown)="onPanelKey($event)"
      >
        <ng-content />
      </div>
    }
  `,
})
export class MenuComponent {
  readonly label = input.required<string>();
  readonly icon = input<IconName | null>(null);
  readonly text = input<string | null>(null);
  readonly variant = input<'default' | 'primary' | 'ghost'>('default');
  readonly disabled = input(false);
  /** Which edge of the trigger the menu lines up with. */
  readonly align = input<'start' | 'end'>('start');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  protected readonly open = signal(false);

  protected toggle(): void {
    if (this.open()) this.close();
    else this.show();
  }

  private show(): void {
    this.open.set(true);
    afterNextRender(() => this.place(), { injector: this.injector });
    queueMicrotask(() => setTimeout(() => this.items()[0]?.focus()));
  }

  /**
   * Lines the panel up with the trigger, using the panel's real size: below it (above when there is
   * more room there), kept inside the window. `position: fixed` is relative to the window only when
   * no ancestor is the containing block; the admin element's `contain: layout` (and any host-page
   * transform) is one, so the panel's actual origin is measured and subtracted. Runs before paint.
   */
  private place(): void {
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    const trigger = this.trigger().nativeElement;
    const a = trigger.getBoundingClientRect();
    panel.style.left = '0px';
    panel.style.top = '0px';
    const origin = panel.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const rtl = getComputedStyle(trigger).direction === 'rtl';
    const alignRight = (this.align() === 'end') !== rtl;
    const preferred = alignRight ? a.right - origin.width : a.left;
    const left = Math.max(8, Math.min(preferred, viewportWidth - origin.width - 8));
    const below = viewportHeight - a.bottom - 4;
    const above = a.top - 4;
    const top =
      origin.height > below && above > below
        ? Math.max(8, a.top - 4 - origin.height)
        : a.bottom + 4;
    panel.style.left = `${Math.round(left - origin.left)}px`;
    panel.style.top = `${Math.round(top - origin.top)}px`;
  }

  protected close(returnFocus = false): void {
    if (!this.open()) return;
    this.open.set(false);
    if (returnFocus) this.trigger().nativeElement.focus();
  }

  private items(): HTMLElement[] {
    const panel = this.panel()?.nativeElement;
    return panel
      ? Array.from(panel.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'))
      : [];
  }

  protected onDocumentClick(event: Event): void {
    // composedPath(): inside a shadow root the document-level target is retargeted to the shadow host.
    if (this.open() && !event.composedPath().includes(this.host.nativeElement)) this.close();
  }

  protected onPanelClick(event: Event): void {
    if ((event.target as HTMLElement).closest('[role^="menuitem"]:not(:disabled)'))
      this.close(true);
  }

  protected onTriggerKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' && !this.open()) {
      event.preventDefault();
      this.show();
    }
  }

  protected onPanelKey(event: KeyboardEvent): void {
    const items = this.items();
    const root = this.host.nativeElement.getRootNode() as Document | ShadowRoot;
    const index = items.indexOf(root.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(index + 1);
      case 'ArrowUp':
        return move(index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(items.length - 1);
      case 'Escape':
        event.preventDefault();
        return this.close(true);
      case 'Tab':
        return this.close();
    }
  }
}
