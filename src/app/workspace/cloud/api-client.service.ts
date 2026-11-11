import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ProductConfig } from '../../customizer/models/product.models';
import type { ConfigurationRecord } from '../configuration.models';
import { uuid } from '../../customizer/util/ids';
import { RuntimeConfig } from './runtime-config';

/** Success envelope returned by the Worker. */
interface Envelope<T> {
  data: T;
  meta?: { pagination?: PageMeta };
  requestId: string;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AssetDto {
  id: string;
  configId: string | null;
  objectKey: string;
  originalFilename: string | null;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  checksumSha256: string | null;
  status: 'pending' | 'stored' | 'deleted';
  clientRef: string | null;
  createdAt: number;
  deliveryUrl: string;
}

export interface ConfigVersionSummaryDto {
  versionId: string;
  version: number;
  createdAt: number;
}
export interface ConfigVersionDto extends ConfigVersionSummaryDto {
  snapshot: ProductConfig;
}

/** Typed transport error. The repository maps these onto the domain errors the UI already handles. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

@Service()
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly runtime = inject(RuntimeConfig);

  private base(): string {
    const root = this.runtime.apiBaseUrl();
    if (!root) throw new ApiClientError(0, 'not_configured', 'No API base URL is configured.');
    return `${root}/api/v1/plugins/personalization`;
  }

  private headers(json = true): HttpHeaders {
    let headers = new HttpHeaders().set('X-Request-Id', uuid());
    const token = this.runtime.authToken();
    if (token) headers = headers.set('Authorization', `Bearer ${token}`);
    if (json) headers = headers.set('Content-Type', 'application/json');
    return headers;
  }

  private async request<T>(fn: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
    try {
      return await fn();
    } catch (error) {
      throw this.toError(error);
    }
  }

  private toError(error: unknown): ApiClientError {
    if (error instanceof ApiClientError) return error;
    if (error instanceof HttpErrorResponse) {
      const body = error.error as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | null;
      const info = body?.error;
      if (error.status === 0) {
        return new ApiClientError(0, 'network', 'The server could not be reached.');
      }
      return new ApiClientError(
        error.status,
        info?.code ?? 'http_error',
        info?.message ?? error.message,
        info?.details,
        info?.requestId,
      );
    }
    return new ApiClientError(0, 'unknown', error instanceof Error ? error.message : String(error));
  }

  // ---- generic plugin routes (mappings, markups ...) ----

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<Envelope<T>> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params = params.set(key, String(value));
    }
    return this.request(() =>
      firstValueFrom(this.http.get<Envelope<T>>(`${this.base()}${path}`, { headers: this.headers(false), params })),
    );
  }

  /**
   * A binary response (private files). The token travels in the Authorization header like every other
   * call — never in the URL — and the bytes come back as a Blob for `downloadBlob` / object URLs.
   */
  async getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
    try {
      const request = firstValueFrom(
        this.http.get(`${this.base()}${path}`, { headers: this.headers(false), responseType: 'blob' }),
      );
      if (!signal) return await request;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return await Promise.race([
        request,
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }),
        ),
      ]);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw this.toError(error);
    }
  }

  async post<T>(path: string, body: unknown): Promise<Envelope<T>> {
    return this.request(() =>
      firstValueFrom(this.http.post<Envelope<T>>(`${this.base()}${path}`, body, { headers: this.headers() })),
    );
  }

  async put<T>(path: string, body: unknown): Promise<Envelope<T>> {
    return this.request(() =>
      firstValueFrom(this.http.put<Envelope<T>>(`${this.base()}${path}`, body, { headers: this.headers() })),
    );
  }

  async remove(path: string): Promise<void> {
    await this.request(async () => {
      await firstValueFrom(this.http.delete(`${this.base()}${path}`, { headers: this.headers(false) }));
      return { data: undefined as unknown as void, requestId: '' };
    });
  }

  // ---- configs ----

  async listConfigs(opts: { includeArchived: boolean; page: number; pageSize: number }): Promise<Envelope<ConfigurationRecord[]>> {
    const params = new HttpParams()
      .set('includeArchived', String(opts.includeArchived))
      .set('page', String(opts.page))
      .set('pageSize', String(opts.pageSize));
    return this.request(() =>
      firstValueFrom(this.http.get<Envelope<ConfigurationRecord[]>>(`${this.base()}/configs`, { headers: this.headers(false), params })),
    );
  }

  async getConfig(id: string): Promise<Envelope<ConfigurationRecord>> {
    return this.request(() =>
      firstValueFrom(this.http.get<Envelope<ConfigurationRecord>>(`${this.base()}/configs/${encodeURIComponent(id)}`, { headers: this.headers(false) })),
    );
  }

  async createConfig(clientConfigId: string, draft: ProductConfig): Promise<Envelope<ConfigurationRecord>> {
    return this.request(() =>
      firstValueFrom(this.http.post<Envelope<ConfigurationRecord>>(`${this.base()}/configs`, { clientConfigId, draft }, { headers: this.headers() })),
    );
  }

  async saveDraft(id: string, draft: ProductConfig, expectedUpdatedAt: number): Promise<Envelope<ConfigurationRecord>> {
    return this.request(() =>
      firstValueFrom(this.http.put<Envelope<ConfigurationRecord>>(`${this.base()}/configs/${encodeURIComponent(id)}`, { draft, expectedUpdatedAt }, { headers: this.headers() })),
    );
  }

  async publish(id: string, expectedUpdatedAt?: number): Promise<Envelope<ConfigurationRecord>> {
    return this.request(() =>
      firstValueFrom(this.http.post<Envelope<ConfigurationRecord>>(`${this.base()}/configs/${encodeURIComponent(id)}/publish`, { expectedUpdatedAt }, { headers: this.headers() })),
    );
  }

  async duplicate(id: string): Promise<Envelope<ConfigurationRecord>> {
    return this.request(() =>
      firstValueFrom(this.http.post<Envelope<ConfigurationRecord>>(`${this.base()}/configs/${encodeURIComponent(id)}/duplicate`, {}, { headers: this.headers() })),
    );
  }

  async archive(id: string): Promise<Envelope<ConfigurationRecord>> {
    return this.request(() =>
      firstValueFrom(this.http.post<Envelope<ConfigurationRecord>>(`${this.base()}/configs/${encodeURIComponent(id)}/archive`, {}, { headers: this.headers() })),
    );
  }

  async restore(id: string): Promise<Envelope<ConfigurationRecord>> {
    return this.request(() =>
      firstValueFrom(this.http.post<Envelope<ConfigurationRecord>>(`${this.base()}/configs/${encodeURIComponent(id)}/restore`, {}, { headers: this.headers() })),
    );
  }

  async deleteConfig(id: string): Promise<void> {
    await this.request(async () => {
      await firstValueFrom(this.http.delete(`${this.base()}/configs/${encodeURIComponent(id)}`, { headers: this.headers(false) }));
      return { data: undefined as unknown as void, requestId: '' };
    });
  }

  async listVersions(id: string): Promise<Envelope<ConfigVersionSummaryDto[]>> {
    return this.request(() =>
      firstValueFrom(this.http.get<Envelope<ConfigVersionSummaryDto[]>>(`${this.base()}/configs/${encodeURIComponent(id)}/versions`, { headers: this.headers(false) })),
    );
  }

  async getVersion(id: string, versionId: string): Promise<Envelope<ConfigVersionDto>> {
    return this.request(() =>
      firstValueFrom(this.http.get<Envelope<ConfigVersionDto>>(`${this.base()}/configs/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`, { headers: this.headers(false) })),
    );
  }

  // ---- assets ----

  async uploadAsset(blob: Blob, opts: { clientRef?: string; configId?: string; filename?: string }): Promise<AssetDto> {
    let params = new HttpParams();
    if (opts.clientRef) params = params.set('clientRef', opts.clientRef);
    if (opts.configId) params = params.set('configId', opts.configId);
    if (opts.filename) params = params.set('filename', opts.filename);
    const headers = this.headers(false).set('Content-Type', blob.type || 'application/octet-stream');
    const envelope = await this.request(() =>
      firstValueFrom(this.http.post<Envelope<AssetDto>>(`${this.base()}/assets`, blob, { headers, params })),
    );
    return envelope.data;
  }

  async listAssets(opts: { kind?: 'image' | 'font'; configId?: string } = {}): Promise<AssetDto[]> {
    const all: AssetDto[] = [];
    for (let page = 1; ; page++) {
      const res = await this.get<AssetDto[]>('/assets', { kind: opts.kind, configId: opts.configId, page, pageSize: 100 });
      all.push(...res.data);
      const meta = res.meta?.pagination as { totalPages?: number } | undefined;
      if (!meta?.totalPages || page >= meta.totalPages) break;
    }
    return all;
  }

  async deleteAsset(id: string): Promise<void> {
    await this.remove(`/assets/${encodeURIComponent(id)}`);
  }
}
