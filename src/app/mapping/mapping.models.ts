import type { MappingScope, ProductMapping } from '../customizer/models/admin-element-contract';

export type { MappingScope, ProductMapping };

export const MAPPING_SCOPES: readonly MappingScope[] = ['product', 'variant', 'collection'];

export interface MappingTarget {
  scope: MappingScope;
  externalId: string;
  label?: string | null;
}

/** The mapping that currently owns a target (the other side of a conflict). */
export interface ExistingMapping {
  id: string;
  configId: string;
  configName?: string | null;
}

/** Another template already owns `(scope, externalId)`, and the caller did not ask to reassign. */
export class MappingConflictError extends Error {
  constructor(
    readonly scope: MappingScope,
    readonly externalId: string,
    readonly existing: ExistingMapping,
  ) {
    super('This target is already mapped to another template.');
    this.name = 'MappingConflictError';
  }
}

export class MappingInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingInvalidError';
  }
}

export interface BulkMappingInput {
  configId: string;
  create?: readonly MappingTarget[];
  deleteIds?: readonly string[];
  /** Move targets that belong to another template instead of reporting a conflict. */
  reassign?: boolean;
}

export interface BulkMappingResult {
  created: ProductMapping[];
  reassigned: ProductMapping[];
  unchanged: ProductMapping[];
  conflicts: { scope: MappingScope; externalId: string; existing: ExistingMapping }[];
  deleted: number;
}

export const MAX_BULK_ITEMS = 500;
export const MAX_EXTERNAL_ID = 200;

/** Validation shared by every repository implementation. */
export function validateTarget(target: MappingTarget): void {
  if (!MAPPING_SCOPES.includes(target.scope))
    throw new MappingInvalidError('Unknown mapping scope.');
  const id = target.externalId;
  if (
    typeof id !== 'string' ||
    id.trim() !== id ||
    id.length === 0 ||
    id.length > MAX_EXTERNAL_ID
  ) {
    throw new MappingInvalidError(
      `The id must be 1-${MAX_EXTERNAL_ID} characters without surrounding spaces.`,
    );
  }
  if (target.label != null && target.label.length > 200) {
    throw new MappingInvalidError('The name must be at most 200 characters.');
  }
}

export const targetKey = (scope: MappingScope, externalId: string): string =>
  `${scope}:${externalId}`;
