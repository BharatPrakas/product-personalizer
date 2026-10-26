import { Service } from '@angular/core';
import { dbDelete, dbGetAll, dbPut } from '../customizer/services/local-db';
import { uuid } from '../customizer/util/ids';
import {
  MAX_PAYLOAD_BYTES,
  Markup,
  MarkupInvalidError,
  MarkupKind,
  MarkupNameTakenError,
  MarkupPayload,
  parsePayload,
  validateName,
} from './markup.models';
import { MarkupQuery, MarkupRepository } from './markup-repository';

/** Browser-stored markups (memory for the session when IndexedDB is unavailable). */
@Service()
export class LocalMarkupRepository extends MarkupRepository {
  private memory: Map<string, Markup> | null = null;

  private async all(): Promise<Markup[]> {
    if (this.memory) return [...this.memory.values()];
    try {
      return await dbGetAll<Markup>('markups');
    } catch {
      this.memory = new Map();
      return [];
    }
  }

  private async put(markup: Markup): Promise<void> {
    if (!this.memory) {
      try {
        await dbPut('markups', markup);
        return;
      } catch {
        this.memory = new Map((await this.all()).map((m) => [m.id, m]));
      }
    }
    this.memory.set(markup.id, markup);
  }

  async list(query: MarkupQuery = {}): Promise<Markup[]> {
    const needle = query.search?.trim().toLowerCase();
    return (await this.all())
      .filter(
        (m) =>
          (!query.kind || m.kind === query.kind) &&
          (!needle || m.name.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(input: { name: string; kind: MarkupKind; payload: MarkupPayload }): Promise<Markup> {
    const name = validateName(input.name);
    parsePayload(input.payload, input.kind);
    if (JSON.stringify(input.payload).length > MAX_PAYLOAD_BYTES) {
      throw new MarkupInvalidError('This markup is too large to save.');
    }
    await this.assertFree(input.kind, name);
    const now = Date.now();
    const markup: Markup = {
      id: uuid(),
      name,
      kind: input.kind,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
    };
    await this.put(markup);
    return markup;
  }

  async rename(id: string, name: string): Promise<Markup> {
    const next = validateName(name);
    const current = (await this.all()).find((m) => m.id === id);
    if (!current) throw new MarkupInvalidError('The markup no longer exists.');
    await this.assertFree(current.kind, next, id);
    const updated = { ...current, name: next, updatedAt: Date.now() };
    await this.put(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (this.memory) {
      this.memory.delete(id);
      return;
    }
    try {
      await dbDelete('markups', id);
    } catch {
      this.memory = new Map((await this.all()).map((m) => [m.id, m]));
      this.memory.delete(id);
    }
  }

  private async assertFree(kind: MarkupKind, name: string, ignoreId?: string): Promise<void> {
    const lower = name.toLowerCase();
    const clash = (await this.all()).some(
      (m) => m.kind === kind && m.id !== ignoreId && m.name.toLowerCase() === lower,
    );
    if (clash) throw new MarkupNameTakenError();
  }
}
