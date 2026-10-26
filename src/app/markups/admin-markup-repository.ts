import { Service, inject } from '@angular/core';
import { AdminEvents } from '../admin/admin-events.service';
import { AdminHost } from '../admin/admin-host.service';
import { ReadOnlyError, toAdminError } from '../admin/admin-errors';
import { RuntimeConfig } from '../workspace/cloud/runtime-config';
import { CloudMarkupRepository } from './cloud-markup-repository.service';
import { LocalMarkupRepository } from './local-markup-repository.service';
import {
  Markup,
  MarkupInvalidError,
  MarkupKind,
  MarkupNameTakenError,
  MarkupPayload,
} from './markup.models';
import { MarkupQuery, MarkupRepository } from './markup-repository';

/** Chooses browser or cloud per call and enforces `readonly`. */
@Service()
export class AdminMarkupRepository extends MarkupRepository {
  private readonly local = inject(LocalMarkupRepository);
  private readonly cloud = inject(CloudMarkupRepository);
  private readonly runtime = inject(RuntimeConfig);
  private readonly host = inject(AdminHost);
  private readonly events = inject(AdminEvents);

  private async run<T>(write: boolean, fn: (repo: MarkupRepository) => Promise<T>): Promise<T> {
    try {
      if (write && this.host.readonly()) throw new ReadOnlyError();
      return await fn(this.runtime.useCloud() ? this.cloud : this.local);
    } catch (error) {
      // Name clashes and bad input are answered in the dialog, not reported as element errors.
      if (!(error instanceof MarkupNameTakenError || error instanceof MarkupInvalidError)) {
        this.events.error(toAdminError(error));
      }
      throw error;
    }
  }

  list(query?: MarkupQuery): Promise<Markup[]> {
    return this.run(false, (r) => r.list(query));
  }
  create(input: { name: string; kind: MarkupKind; payload: MarkupPayload }): Promise<Markup> {
    return this.run(true, (r) => r.create(input));
  }
  rename(id: string, name: string): Promise<Markup> {
    return this.run(true, (r) => r.rename(id, name));
  }
  delete(id: string): Promise<void> {
    return this.run(true, (r) => r.delete(id));
  }
}
