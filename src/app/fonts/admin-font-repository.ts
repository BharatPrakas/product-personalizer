import { Service, inject } from '@angular/core';
import { AdminEvents } from '../admin/admin-events.service';
import { AdminHost } from '../admin/admin-host.service';
import { ReadOnlyError, toAdminError } from '../admin/admin-errors';
import { RuntimeConfig } from '../workspace/cloud/runtime-config';
import { CloudFontRepository } from './cloud-font-repository.service';
import { LocalFontRepository } from './local-font-repository.service';
import { FontFileInvalidError, FontLabelInvalidError, type CustomFont } from './font.models';
import { FontRepository } from './font-repository';

/** Chooses the cloud or the (feature-less) local repository per call, and enforces `readonly`. */
@Service()
export class AdminFontRepository extends FontRepository {
  private readonly local = inject(LocalFontRepository);
  private readonly cloud = inject(CloudFontRepository);
  private readonly runtime = inject(RuntimeConfig);
  private readonly host = inject(AdminHost);
  private readonly events = inject(AdminEvents);

  private async run<T>(write: boolean, fn: (repo: FontRepository) => Promise<T>): Promise<T> {
    try {
      if (write && this.host.readonly()) throw new ReadOnlyError();
      return await fn(this.runtime.useCloud() ? this.cloud : this.local);
    } catch (error) {
      // Answered in the dialog, not reported as an element-level error.
      if (!(error instanceof FontLabelInvalidError || error instanceof FontFileInvalidError)) {
        this.events.error(toAdminError(error));
      }
      throw error;
    }
  }

  list(): Promise<CustomFont[]> {
    return this.run(false, (r) => r.list());
  }
  upload(input: { blob: Blob; label: string; filename?: string }): Promise<CustomFont> {
    return this.run(true, (r) => r.upload(input));
  }
  delete(id: string): Promise<void> {
    return this.run(true, (r) => r.delete(id));
  }
}
