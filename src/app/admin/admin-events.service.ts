import { Service } from '@angular/core';
import type {
  AdminErrorDetail,
  ConfigArchivedDetail,
  ConfigPublishedDetail,
  ConfigSavedDetail,
  MappingChangedDetail,
  ViewChangeDetail,
  ZbPersonalizationAdminEventMap,
} from '../customizer/models/admin-element-contract';

type Details = {
  [
    K in keyof ZbPersonalizationAdminEventMap
  ]: ZbPersonalizationAdminEventMap[K] extends CustomEvent<infer D> ? D : never;
};

/** Dispatches the element's public events on the host element. Inert when not embedded. */
@Service()
export class AdminEvents {
  private target: HTMLElement | null = null;

  attach(element: HTMLElement | null): void {
    this.target = element;
  }

  emit<K extends keyof Details>(name: K, detail: Details[K]): void {
    // Non-bubbling and not composed: events are for listeners on the element itself.
    this.target?.dispatchEvent(new CustomEvent(name, { detail }));
  }

  viewChange(detail: ViewChangeDetail): void {
    this.emit('view-change', detail);
  }
  configSaved(detail: ConfigSavedDetail): void {
    this.emit('config-saved', detail);
  }
  configPublished(detail: ConfigPublishedDetail): void {
    this.emit('config-published', detail);
  }
  configArchived(detail: ConfigArchivedDetail): void {
    this.emit('config-archived', detail);
  }
  mappingChanged(detail: MappingChangedDetail): void {
    this.emit('mapping-changed', detail);
  }
  error(detail: AdminErrorDetail): void {
    this.emit('admin-error', detail);
  }
}
