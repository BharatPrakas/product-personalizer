import type { Signal } from '@angular/core';
import type { MessageKey } from '../admin/i18n/messages.en';
import type { ConfigIssue } from '../customizer/models/config.models';
import type { ProductConfig } from '../customizer/models/product.models';
import type { ConfigurationRecord } from './configuration.models';

export interface StorageInfo {
  kind: 'browser' | 'memory' | 'cloud';
  /** Message shown to the merchant, so persistence is never overstated. */
  labelKey: MessageKey;
  /** False when changes would be lost on reload. */
  persistent: boolean;
}

export class ConfigurationNotFoundError extends Error {
  constructor(id: string) {
    super(`Configuration "${id}" was not found.`);
    this.name = 'ConfigurationNotFoundError';
  }
}

/** The stored copy changed since it was opened (another tab, another session). */
export class ConfigurationConflictError extends Error {
  constructor() {
    super('This configuration was changed somewhere else since you opened it.');
    this.name = 'ConfigurationConflictError';
  }
}

export class ConfigurationInvalidError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`The configuration has ${issues.length} problem(s).`);
    this.name = 'ConfigurationInvalidError';
  }
}

export class StorageError extends Error {
  constructor(message = 'The browser could not store this change.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
  }
}

export interface NewConfigurationInput {
  name: string;
  /** Optional first mockup, as a stored image reference (`idb:<id>`). */
  mockupSrc?: string;
  mockupName?: string;
}

/**
 * Where configurations live. The standalone application uses the browser (IndexedDB); a hosted
 * deployment provides another implementation (for example one that calls a ZenBasket API) without
 * the UI changing. Every method resolves only after the change is actually stored.
 */
export abstract class ConfigurationRepository {
  abstract readonly storage: Signal<StorageInfo>;

  abstract list(options?: { includeArchived?: boolean }): Promise<ConfigurationRecord[]>;
  abstract get(id: string): Promise<ConfigurationRecord | null>;
  abstract create(input: NewConfigurationInput): Promise<ConfigurationRecord>;
  /** Store an already-built draft (an imported file) as a new configuration with a fresh id. */
  abstract createFromDraft(draft: ProductConfig): Promise<ConfigurationRecord>;
  /**
   * Store the working draft. `expectedUpdatedAt` is the `updatedAt` the caller loaded; a mismatch
   * rejects with `ConfigurationConflictError` instead of overwriting someone else's save.
   */
  abstract saveDraft(
    id: string,
    draft: ProductConfig,
    expectedUpdatedAt: number,
  ): Promise<ConfigurationRecord>;
  /** Validate strictly, then turn the stored draft into the published snapshot. */
  abstract publish(id: string): Promise<ConfigurationRecord>;
  abstract duplicate(id: string): Promise<ConfigurationRecord>;
  abstract archive(id: string): Promise<ConfigurationRecord>;
  abstract restore(id: string): Promise<ConfigurationRecord>;
  abstract delete(id: string): Promise<void>;
}
