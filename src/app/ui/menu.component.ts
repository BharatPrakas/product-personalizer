import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
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
        [style.top.px]="position().top"
        [style.left.px]="position().left"
        (click)="onPanelClick($event)"
        (keydown)="onPanelKey($event)"
      >
        <ng-content />
      </div>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
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
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  protected readonly open = signal(false);
  private readonly anchor = signal({ top: 0, left: 0, right: 0, bottom: 0 });
  protected readonly position = computed(() => {
    const a = this.anchor();
    const width = 240;
    const left =
      this.align() === 'end'
        ? Math.max(8, a.right - width)
        : Math.min(a.left, window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - a.bottom;
    return {
      left,
      top: spaceBelow < 260 && a.top > spaceBelow ? Math.max(8, a.top - 260) : a.bottom + 4,
    };
  });

  protected toggle(): void {
    if (this.open()) this.close();
    else this.show();
  }

  private show(): void {
    const r = this.trigger().nativeElement.getBoundingClientRect();
    this.anchor.set({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
    this.open.set(true);
    queueMicrotask(() => setTimeout(() => this.items()[0]?.focus()));
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
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close();
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
    const index = items.indexOf(document.activeElement as HTMLElement);
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
