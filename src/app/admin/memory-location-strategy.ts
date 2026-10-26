import { LocationChangeListener, LocationStrategy } from '@angular/common';
import { Injectable } from '@angular/core';

/**
 * Keeps the router's history in memory. The admin element is a widget inside somebody else's page:
 * it must never read or change `location` / `history`, so navigation between its views is
 * invisible to the host (which learns about it through `view-change`).
 */
@Injectable()
export class MemoryLocationStrategy extends LocationStrategy {
  private readonly entries: { path: string; state: unknown }[] = [{ path: '', state: null }];
  private index = 0;
  private readonly listeners = new Set<LocationChangeListener>();

  override path(): string {
    return this.entries[this.index].path;
  }

  override prepareExternalUrl(internal: string): string {
    return internal;
  }

  override getState(): unknown {
    return this.entries[this.index].state;
  }

  override pushState(state: unknown, _title: string, url: string, queryParams: string): void {
    this.entries.length = this.index + 1; // drop the forward history
    this.entries.push({ path: url + (queryParams ? `?${queryParams}` : ''), state });
    this.index++;
  }

  override replaceState(state: unknown, _title: string, url: string, queryParams: string): void {
    this.entries[this.index] = { path: url + (queryParams ? `?${queryParams}` : ''), state };
  }

  override forward(): void {
    this.historyGo(1);
  }

  override back(): void {
    this.historyGo(-1);
  }

  override historyGo(relativePosition = 0): void {
    const target = Math.min(Math.max(this.index + relativePosition, 0), this.entries.length - 1);
    if (target === this.index) return;
    this.index = target;
    const state = this.entries[target].state;
    for (const listener of this.listeners) listener({ type: 'popstate', state });
  }

  override onPopState(fn: LocationChangeListener): VoidFunction {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  override getBaseHref(): string {
    return '';
  }
}
