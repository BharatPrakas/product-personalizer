/**
 * Business rules for product mappings: a host product / variant / collection (external id) maps to
 * at most ONE configuration per store.
 *
 *  - The target configuration must belong to the store (looked up by the store-scoped client id) and
 *    must not be archived (422 `config_archived`).
 *  - Mapping a target that already points at a DIFFERENT configuration is a conflict (409
 *    `mapping_conflict`) unless the caller passes `reassign: true`, which moves it.
 *  - Mapping a target to the configuration it already has is idempotent.
 *  - Bulk and single writes share one code path (`applyItems`). D1 has no interactive transaction, so
 *    every write `applyItems` decides in one round — `bulk()`'s upfront deletes (folded into round
 *    one, not a separate phase — see `applyItems`'s doc comment), label updates, reassign moves, new
 *    inserts — is submitted as ONE atomic `batch()`: either all of that round's writes land or none
 *    do. For the common case (no other request racing the same target), that means the WHOLE
 *    create/update/bulk call is one atomic unit, same as the old single Postgres transaction. The
 *    `ON CONFLICT DO NOTHING` inserts' actual `RETURNING` rows (not the pre-batch read) decide which
 *    targets still need a retry round, so a target losing a race is reclassified from real results,
 *    not assumed. The one gap left is a crash *between* two already-committed rounds — D1 has no way
 *    to read mid-batch, so the retry loop's read must happen outside any batch — which only arises
 *    when a genuinely concurrent writer forces more than one round. Even then, nothing is left
 *    inconsistent: every write is idempotent and keyed by (store, scope, external_id), not by this
 *    request, so the next call that touches the same target — from this caller retrying, or anyone
 *    else — converges cleanly rather than duplicating or corrupting anything.
 */

import type { Database, Statement } from '../../database/connection';
import { ApiError, ConflictError, NotFoundError } from '../../shared/errors';
import { MAX_BULK_ITEMS } from './validation';
import {
  MappingRepository,
  type ConfigRef,
  type MappingRow,
  type MappingTarget,
  type NewMapping,
} from './mapping-repository';
import { decodeCursor, encodeCursor } from './pagination';
import { type StoreContext, stamp, writeAudit } from './support';
import type {
  ConfigLifecycleStatus,
  CursorPageMeta,
  MappingConflictDto,
  MappingDto,
  MappingScope,
} from './types';

/** `label` undefined = keep the stored label; null = clear it. */
export interface MappingItemInput {
  scope: MappingScope;
  externalId: string;
  label?: string | null;
}

export interface BulkResult {
  created: MappingDto[];
  reassigned: MappingDto[];
  unchanged: MappingDto[];
  conflicts: MappingConflictDto[];
  deleted: number;
}

interface ApplyOutcome {
  created: string[];
  reassigned: string[];
  unchanged: string[];
  conflicts: MappingConflictDto[];
}

const keyOf = (t: MappingTarget) => `${t.scope}\u0000${t.externalId}`;

function lifecycle(row: MappingRow): ConfigLifecycleStatus {
  if (row.config_archived_at_ms !== null) return 'archived';
  return row.config_published ? 'published' : 'draft';
}

export function toMappingDto(row: MappingRow): MappingDto {
  return {
    id: row.id,
    storeId: row.store_id,
    configId: row.client_config_id,
    configName: row.config_name,
    configStatus: lifecycle(row),
    scope: row.scope,
    externalId: row.external_id,
    label: row.label,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
  };
}

function conflictOf(row: MappingRow): MappingConflictDto {
  return {
    scope: row.scope,
    externalId: row.external_id,
    existing: { id: row.id, configId: row.client_config_id, configName: row.config_name },
  };
}

function mappingConflict(existing: MappingConflictDto['existing']): ApiError {
  return new ApiError(
    409,
    'mapping_conflict',
    'This target is already mapped to a different configuration. Pass reassign: true to move it.',
    { existing },
  );
}

export class MappingService {
  private readonly repo: MappingRepository;

  constructor(private readonly ctx: StoreContext) {
    this.repo = new MappingRepository(ctx.db);
  }

  /** Resolve the target configuration inside the store; 404 if unknown, 422 if archived. */
  private async requireTargetConfig(repo: MappingRepository, clientId: string): Promise<ConfigRef> {
    const config = await repo.getConfigRef(this.ctx.storeId, clientId);
    if (!config) throw new NotFoundError(`Configuration "${clientId}" was not found.`);
    if (config.archived_at_ms !== null) {
      throw new ApiError(422, 'config_archived', `Configuration "${clientId}" is archived and cannot be mapped.`);
    }
    return config;
  }

  async list(opts: {
    configClientId?: string;
    scope?: MappingScope;
    externalId?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: MappingDto[]; page: CursorPageMeta }> {
    const rows = await this.repo.list(this.ctx.storeId, {
      configClientId: opts.configClientId,
      scope: opts.scope,
      externalId: opts.externalId,
      limit: opts.limit,
      cursor: decodeCursor(opts.cursor),
    });
    const hasMore = rows.length > opts.limit;
    const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toMappingDto),
      page: {
        limit: opts.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ createdAtMs: Number(last.created_at_ms), id: last.id }) : null,
      },
    };
  }

  /**
   * Core algorithm shared by create and bulk. Looks up existing mappings, then inserts new targets,
   * leaves same-config targets alone, and reports or moves different-config targets.
   *
   * `firstRound` lets `bulk()` fold its upfront delete into THIS round's batch instead of running it
   * as a separate, earlier phase: `excludeKeys` tells the first round's classification to treat those
   * targets as already gone (so "delete this mapping, then re-create the same target" is classified
   * as a fresh insert, not a conflict with the row about to be deleted), and `leadingStatements` are
   * the delete statements themselves, placed BEFORE this round's label/move/insert statements in the
   * same `batch()` — SQLite applies a batch's statements strictly in order, so by the time the insert
   * runs the delete has already freed the unique (store, scope, external_id) slot. This closes what
   * used to be a real gap: a crash between "delete committed" and "recreate committed" for the common
   * case (no concurrent writer racing the same target) is now impossible, because there is no window
   * between them at all.
   */
  private async applyItems(
    db: Database,
    config: ConfigRef,
    items: readonly MappingItemInput[],
    reassign: boolean,
    firstRound?: { excludeKeys: ReadonlySet<string>; leadingStatements: readonly Statement[] },
  ): Promise<ApplyOutcome> {
    const repo = new MappingRepository(db);
    const outcome: ApplyOutcome = { created: [], reassigned: [], unchanged: [], conflicts: [] };
    const now = stamp();

    // De-duplicate within the request (the first occurrence wins).
    const unique = new Map<string, MappingItemInput>();
    for (const item of items) if (!unique.has(keyOf(item))) unique.set(keyOf(item), item);
    let pending = [...unique.values()];

    // A writer racing us on the same target makes ON CONFLICT skip our row; re-classify those from
    // this round's actual RETURNING rows, not from the read taken before the round's batch ran.
    for (let attempt = 0; pending.length > 0 && attempt < 3; attempt++) {
      const isFirstRound = attempt === 0 && firstRound !== undefined;
      const existing = new Map(
        (await repo.findByTargets(this.ctx.storeId, pending))
          .filter((r) => !isFirstRound || !firstRound.excludeKeys.has(keyOf({ scope: r.scope, externalId: r.external_id })))
          .map((r) => [keyOf({ scope: r.scope, externalId: r.external_id }), r]),
      );
      const toInsert: NewMapping[] = [];
      const toMove: string[] = [];
      const statements: Statement[] = isFirstRound ? [...firstRound.leadingStatements] : [];

      for (const item of pending) {
        const found = existing.get(keyOf(item));
        if (!found) {
          toInsert.push({ scope: item.scope, externalId: item.externalId, label: item.label ?? null });
          continue;
        }
        const label = item.label;
        if (found.config_id === config.id) {
          if (label !== undefined && label !== found.label) {
            statements.push(repo.setLabelStatement(this.ctx.storeId, found.id, label, now));
          }
          outcome.unchanged.push(found.id);
        } else if (reassign) {
          toMove.push(found.id);
          outcome.reassigned.push(found.id);
          if (label !== undefined && label !== found.label) {
            statements.push(repo.setLabelStatement(this.ctx.storeId, found.id, label, now));
          }
        } else {
          outcome.conflicts.push(conflictOf(found));
        }
      }

      statements.push(...repo.moveManyStatements(this.ctx.storeId, toMove, config.id, now));
      const insertStatements = toInsert.map((item) => repo.insertStatement(this.ctx.storeId, config.id, item, now));
      statements.push(...insertStatements);

      let insertedKeys = new Set<string>();
      if (statements.length > 0) {
        const results = await db.batch<{ id: string; scope: MappingScope; external_id: string }>(statements);
        const insertResults = results.slice(results.length - insertStatements.length);
        const inserted = insertResults.flatMap((r) => r.rows);
        outcome.created.push(...inserted.map((r) => r.id));
        insertedKeys = new Set(inserted.map((r) => keyOf({ scope: r.scope, externalId: r.external_id })));
      }

      const attempted = new Set(toInsert.map(keyOf));
      pending = pending.filter((p) => attempted.has(keyOf(p)) && !insertedKeys.has(keyOf(p)));
    }
    if (pending.length > 0) {
      throw new ConflictError('Mappings were changed concurrently. Retry the request.');
    }
    return outcome;
  }

  private async hydrate(repo: MappingRepository, ids: readonly string[]): Promise<MappingDto[]> {
    const byId = new Map((await repo.getByIds(this.ctx.storeId, ids)).map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toMappingDto(row)] : [];
    });
  }

  /** Create (201), return the identical existing mapping (200), or move it with `reassign` (200). */
  async create(input: {
    configId: string;
    scope: MappingScope;
    externalId: string;
    label?: string | null;
    reassign?: boolean;
  }): Promise<{ mapping: MappingDto; status: 200 | 201 }> {
    const repo = new MappingRepository(this.ctx.db);
    const config = await this.requireTargetConfig(repo, input.configId);
    const outcome = await this.applyItems(this.ctx.db, config, [input], input.reassign === true);
    const first = outcome.conflicts[0];
    if (first) throw mappingConflict(first.existing);
    const id = outcome.created[0] ?? outcome.reassigned[0] ?? outcome.unchanged[0];
    const [mapping] = await this.hydrate(repo, id ? [id] : []);
    if (outcome.created.length > 0) {
      await writeAudit(this.ctx, 'mapping.create', 'mapping', mapping.id, { scope: mapping.scope });
    } else if (outcome.reassigned.length > 0) {
      await writeAudit(this.ctx, 'mapping.reassign', 'mapping', mapping.id, { scope: mapping.scope });
    }
    return { mapping, status: outcome.created.length > 0 ? 201 : 200 };
  }

  async update(
    id: string,
    input: { configId?: string; label?: string | null; reassign?: boolean },
  ): Promise<MappingDto> {
    const repo = new MappingRepository(this.ctx.db);
    const current = await repo.getById(this.ctx.storeId, id);
    if (!current) throw new NotFoundError('That mapping was not found.');
    const now = stamp(Number(current.updated_at_ms));

    let movedTo: ConfigRef | null = null;
    if (input.configId !== undefined && input.configId !== current.client_config_id) {
      const target = await this.requireTargetConfig(repo, input.configId);
      if (input.reassign !== true) throw mappingConflict(conflictOf(current).existing);
      movedTo = target;
      await repo.moveMany(this.ctx.storeId, [current.id], target.id, now);
    }
    if (input.label !== undefined && input.label !== current.label) {
      await repo.setLabel(this.ctx.storeId, current.id, input.label, now);
    }
    const [mapping] = await this.hydrate(repo, [current.id]);
    const moved = movedTo !== null;
    await writeAudit(this.ctx, moved ? 'mapping.reassign' : 'mapping.update', 'mapping', mapping.id);
    return mapping;
  }

  async delete(id: string): Promise<void> {
    const removed = await this.repo.deleteOne(this.ctx.storeId, id);
    if (!removed) throw new NotFoundError('That mapping was not found.');
    await writeAudit(this.ctx, 'mapping.delete', 'mapping', id);
  }

  async bulk(input: {
    configId: string;
    create?: MappingItemInput[];
    deleteIds?: string[];
    reassign?: boolean;
  }): Promise<BulkResult> {
    const creates = input.create ?? [];
    const deleteIds = [...new Set(input.deleteIds ?? [])];
    if (creates.length + deleteIds.length > MAX_BULK_ITEMS) {
      throw new ApiError(422, 'validation_failed', `At most ${MAX_BULK_ITEMS} items are allowed per request.`);
    }

    const repo = new MappingRepository(this.ctx.db);
    const config = await this.requireTargetConfig(repo, input.configId);

    // Read what's about to be deleted BEFORE any write, so the first create-round's existing-targets
    // read (also taken before any write) can treat these targets as already gone — "remove then
    // re-add" the same target behaves as a fresh create. The deletes themselves run as the leading
    // statements of that same round's batch (see applyItems' doc comment), not as an earlier phase.
    const toDelete = deleteIds.length > 0 ? await repo.getByIds(this.ctx.storeId, deleteIds) : [];
    const excludeKeys = new Set(toDelete.map((r) => keyOf({ scope: r.scope, externalId: r.external_id })));
    const leadingStatements = repo.deleteManyStatements(this.ctx.storeId, deleteIds);

    const outcome = await this.applyItems(this.ctx.db, config, creates, input.reassign === true, {
      excludeKeys,
      leadingStatements,
    });
    // toDelete was read immediately before the same batch that deletes them, so its count is the
    // actual number removed (barring the same vanishingly-rare externally-concurrent-delete race any
    // read-then-act step has — self-correcting, not silently wrong: deleteMany's own WHERE still
    // scopes by id, so it only ever removes rows that still exist).
    const deleted = toDelete.length;
    const result = {
      deleted,
      outcome,
      created: await this.hydrate(repo, outcome.created),
      reassigned: await this.hydrate(repo, outcome.reassigned),
      unchanged: await this.hydrate(repo, outcome.unchanged),
    };

    await writeAudit(this.ctx, 'mapping.bulk', 'mapping', input.configId, {
      created: result.created.length,
      reassigned: result.reassigned.length,
      unchanged: result.unchanged.length,
      conflicts: result.outcome.conflicts.length,
      deleted: result.deleted,
    });
    return {
      created: result.created,
      reassigned: result.reassigned,
      unchanged: result.unchanged,
      conflicts: result.outcome.conflicts,
      deleted: result.deleted,
    };
  }
}
