import type { ProductMapping } from '../customizer/models/admin-element-contract';
import type {
  BulkMappingInput,
  BulkMappingResult,
  MappingScope,
  MappingTarget,
} from './mapping.models';

export interface MappingFilter {
  configId?: string;
  scope?: MappingScope;
  externalId?: string;
}

/**
 * Where product mappings live. Same split as `ConfigurationRepository`: the browser (IndexedDB)
 * by default, the personalization API when the host supplies `apiBaseUrl`. Every method rejects
 * with `MappingConflictError` / `MappingInvalidError` rather than silently overwriting.
 */
export abstract class ProductMappingRepository {
  abstract list(filter?: MappingFilter): Promise<ProductMapping[]>;
  /** Idempotent for the same template; another template's target needs `reassign`. */
  abstract create(
    input: MappingTarget & { configId: string; reassign?: boolean },
  ): Promise<ProductMapping>;
  abstract update(
    id: string,
    patch: { configId?: string; label?: string | null; reassign?: boolean },
  ): Promise<ProductMapping>;
  abstract delete(id: string): Promise<void>;
  abstract bulk(input: BulkMappingInput): Promise<BulkMappingResult>;
  /** Drop every mapping of a template that no longer exists (the cloud does this by cascade). */
  abstract deleteForConfig(configId: string): Promise<number>;
}
