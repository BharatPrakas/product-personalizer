import { Service, inject } from '@angular/core';
import { ApiClient, ApiClientError } from '../workspace/cloud/api-client.service';
import {
  Markup,
  MarkupInvalidError,
  MarkupKind,
  MarkupNameTakenError,
  MarkupPayload,
  validateName,
} from './markup.models';
import { MarkupQuery, MarkupRepository } from './markup-repository';

/** Markups kept by the personalization API, scoped to the token's store. */
@Service()
export class CloudMarkupRepository extends MarkupRepository {
  private readonly api = inject(ApiClient);

  async list(query: MarkupQuery = {}): Promise<Markup[]> {
    const all: Markup[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.api.get<Markup[]>('/markups', {
        kind: query.kind,
        search: query.search?.trim() || undefined,
        limit: 200,
        cursor,
      });
      all.push(...res.data);
      const page = res.meta?.pagination as
        { hasMore?: boolean; nextCursor?: string | null } | undefined;
      cursor = page?.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return all;
  }

  async create(input: { name: string; kind: MarkupKind; payload: MarkupPayload }): Promise<Markup> {
    const name = validateName(input.name);
    return this.guard(
      async () => (await this.api.post<Markup>('/markups', { ...input, name })).data,
    );
  }

  async rename(id: string, name: string): Promise<Markup> {
    const next = validateName(name);
    return this.guard(
      async () =>
        (await this.api.put<Markup>(`/markups/${encodeURIComponent(id)}`, { name: next })).data,
    );
  }

  async delete(id: string): Promise<void> {
    await this.api.remove(`/markups/${encodeURIComponent(id)}`);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.status === 409 && error.code === 'markup_name_taken')
          throw new MarkupNameTakenError();
        if (error.status === 422 || error.status === 413)
          throw new MarkupInvalidError(error.message);
      }
      throw error;
    }
  }
}
