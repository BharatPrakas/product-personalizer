import { Component, inject } from '@angular/core';
import { IconComponent, IconName } from '../../ui/icon.component';
import { EditorStore, SidebarTab } from '../services/editor-store.service';
import { AreasTabComponent } from './areas-tab.component';
import { ArtworksTabComponent } from './artworks-tab.component';
import { LayersTabComponent } from './layers-tab.component';
import { MockupsTabComponent } from './mockups-tab.component';

interface Tab {
  id: SidebarTab;
  label: string;
  icon: IconName;
}

/** Left sidebar: the structure of the configuration, one task per tab. */
@Component({
  selector: 'app-design-sidebar',
  imports: [
    IconComponent,
    MockupsTabComponent,
    AreasTabComponent,
    ArtworksTabComponent,
    LayersTabComponent,
  ],
  template: `
    <div class="tabs" role="tablist" aria-label="Design structure" (keydown)="onKey($event)">
      @for (tab of tabs; track tab.id) {
        <button
          type="button"
          role="tab"
          class="tab"
          [id]="'tab-' + tab.id"
          [attr.aria-selected]="store.sidebarTab() === tab.id"
          [attr.aria-controls]="'tabpanel-' + tab.id"
          [attr.tabindex]="store.sidebarTab() === tab.id ? 0 : -1"
          (click)="store.sidebarTab.set(tab.id)"
        >
          <app-icon [name]="tab.icon" [size]="18" />
          <span>{{ tab.label }}</span>
        </button>
      }
    </div>
    <div
      class="tab-panel"
      role="tabpanel"
      [id]="'tabpanel-' + store.sidebarTab()"
      [attr.aria-labelledby]="'tab-' + store.sidebarTab()"
      tabindex="-1"
    >
      @switch (store.sidebarTab()) {
        @case ('mockups') {
          <app-mockups-tab />
        }
        @case ('areas') {
          <app-areas-tab />
        }
        @case ('artworks') {
          <app-artworks-tab />
        }
        @case ('layers') {
          <app-layers-tab />
        }
      }
    </div>
  `,
})
export class DesignSidebarComponent {
  protected readonly store = inject(EditorStore);
  protected readonly tabs: Tab[] = [
    { id: 'mockups', label: 'Mockups', icon: 'mockup' },
    { id: 'areas', label: 'Areas', icon: 'area' },
    { id: 'artworks', label: 'Artworks', icon: 'artwork' },
    { id: 'layers', label: 'Layers', icon: 'layers' },
  ];

  /** Arrow keys move between tabs, as in the ARIA tabs pattern. */
  protected onKey(event: KeyboardEvent): void {
    const index = this.tabs.findIndex((t) => t.id === this.store.sidebarTab());
    const next =
      event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const tab = this.tabs[(next + this.tabs.length) % this.tabs.length];
    this.store.sidebarTab.set(tab.id);
    queueMicrotask(() => document.getElementById(`tab-${tab.id}`)?.focus());
  }
}
