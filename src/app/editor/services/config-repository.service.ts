import { Service, inject, signal } from '@angular/core';
import { ConfigIssue } from '../../customizer/models/config.models';
import { PRODUCT_SCHEMA_VERSION, ProductConfig } from '../../customizer/models/product.models';
import { validateConfig } from '../../customizer/util/config-validator';
import { upgradeV1 } from '../../customizer/util/config-upgrade';
import { uuid } from '../../customizer/util/ids';
import { validateProductConfig } from '../../customizer/util/product-validator';
import { isLocalAssetUrl, resolveBase } from '../../customizer/util/url-policy';
import { dbClear, dbDelete, dbGet, dbGetAll, dbPut } from '../../customizer/services/local-db';
import { LocalAssetLibrary } from '../../customizer/services/local-asset-library.service';

export interface StoredConfig {
  id: string;
  config: ProductConfig;
  updatedAt: number;
  /** Fixture file this configuration was seeded from (enables "restore sample"). */
  sample?: string;
}

export type ImportResult =
  { ok: true; config: ProductConfig } | { ok: false; issues: ConfigIssue[] };

const SEEDED_KEY = 'zb-personalizer-seeded';
const SAMPLE_DIR = 'data/products/';

/** Validate a configuration the way the editor and storefront do (browser-stored assets allowed). */
export function validateLocal(raw: unknown) {
  return validateProductConfig(raw, {
    resolvedBase: resolveBase({ configUrl: null, baseUrl: null, documentBase: document.baseURI }),
    policy: { pageOrigin: location.origin, allowedOrigins: [], allowLocalAssets: true },
  });
}

/**
 * Local persistence for merchant configurations: IndexedDB (falling back to memory with a visible
 * note), demo seeding from the bundled fixtures, import / export with embedded images.
 */
@Service()
export class ConfigRepository {
  private readonly library = inject(LocalAssetLibrary);
  private readonly memory = new Map<string, StoredConfig>();
  private seeding: Promise<void> | null = null;

  /** Set when IndexedDB is unavailable and edits live in memory only. */
  readonly storageNote = signal<string | null>(null);

  // ---- reads -----------------------------------------------------------------------------------

  async list(): Promise<StoredConfig[]> {
    await this.ensureSeeded();
    let stored: StoredConfig[] = [];
    try {
      stored = await dbGetAll<StoredConfig>('configs');
    } catch {
      this.noteMemoryOnly();
      stored = [...this.memory.values()];
    }
    return stored.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async get(id: string): Promise<StoredConfig | null> {
    await this.ensureSeeded();
    try {
      return (await dbGet<StoredConfig>('configs', id)) ?? null;
    } catch {
      this.noteMemoryOnly();
      return this.memory.get(id) ?? null;
    }
  }

  // ---- writes ----------------------------------------------------------------------------------

  async save(config: ProductConfig, sample?: string): Promise<StoredConfig> {
    // Reads storage directly: `get` waits for seeding, and seeding itself saves.
    const existing = await this.rawGet(config.id);
    const record: StoredConfig = {
      id: config.id,
      config: structuredClone(config),
      updatedAt: Date.now(),
      ...((sample ?? existing?.sample) ? { sample: sample ?? existing?.sample } : {}),
    };
    this.memory.set(record.id, record);
    try {
      await dbPut('configs', record);
    } catch {
      this.noteMemoryOnly();
    }
    return record;
  }

  async remove(id: string): Promise<void> {
    this.memory.delete(id);
    try {
      await dbDelete('configs', id);
    } catch {
      this.noteMemoryOnly();
    }
  }

  /** A new, valid, editable configuration: one variant, mockup, area and artwork. */
  async create(name: string): Promise<StoredConfig> {
    const id = `custom-${uuid().slice(0, 8)}`;
    const config: ProductConfig = {
      schemaVersion: PRODUCT_SCHEMA_VERSION,
      id,
      version: 1,
      status: 'draft',
      product: { id: `product-${id.slice(7)}`, name },
      assetBaseUrl: 'assets/',
      variants: [
        {
          id: 'default',
          label: 'Default',
          mockupIds: ['poster'],
          printableAreaIds: ['print-area'],
        },
      ],
      mockups: [
        {
          id: 'poster',
          name: 'Poster frame',
          src: 'mockups/poster-frame.jpg',
          placements: [
            {
              printableAreaId: 'print-area',
              type: 'rect',
              x: 0.275,
              y: 0.1,
              width: 0.45,
              height: 0.8,
            },
          ],
        },
      ],
      printableAreas: [
        {
          id: 'print-area',
          name: 'Print area',
          enabled: true,
          canvas: { width: 1500, height: 2000, background: 'transparent' },
          shape: { type: 'rect' },
          artworkId: 'artwork-1',
          artworkIds: ['artwork-1'],
          boundary: { visible: true, color: '#e11d48', opacity: 0.85 },
        },
      ],
      artworks: [
        {
          id: 'artwork-1',
          name: 'Artwork 1',
          printableAreaId: 'print-area',
          background: '#ffffff',
          layers: [
            {
              id: 'photo-slot',
              type: 'image-placeholder',
              name: 'Photo',
              fieldId: 'photo',
              fit: 'cover',
              x: 150,
              y: 150,
              width: 1200,
              height: 1200,
            },
            {
              id: 'headline',
              type: 'text',
              name: 'Headline',
              fieldId: 'headline',
              fontSize: 150,
              minFontSize: 50,
              align: 'center',
              x: 150,
              y: 1450,
              width: 1200,
              height: 300,
            },
          ],
        },
      ],
      fonts: [
        { id: 'sans', family: 'CustomizerSans', label: 'Sans', src: 'fonts/sans-regular.woff2' },
        {
          id: 'sans-bold',
          family: 'CustomizerSansBold',
          label: 'Sans bold',
          src: 'fonts/sans-bold.woff2',
        },
        {
          id: 'serif',
          family: 'CustomizerSerif',
          label: 'Serif bold',
          src: 'fonts/serif-bold.woff2',
        },
        { id: 'mono', family: 'CustomizerMono', label: 'Mono bold', src: 'fonts/mono-bold.woff2' },
      ],
      fields: [
        {
          id: 'photo',
          type: 'image',
          label: 'Your photo',
          required: true,
          printableAreaId: 'print-area',
          artworkId: 'artwork-1',
          accept: ['image/png', 'image/jpeg'],
        },
        {
          id: 'headline',
          type: 'text',
          label: 'Headline',
          required: false,
          maxLength: 24,
          fontIds: ['sans-bold', 'serif', 'sans', 'mono'],
          colors: ['#111827', '#c2185b', '#296fd7'],
          defaultValue: { text: 'Hello', fontId: 'sans-bold', color: '#111827' },
          placeholder: 'Your headline',
          styleControls: ['bold', 'italic'],
          printableAreaId: 'print-area',
          artworkId: 'artwork-1',
        },
      ],
    };
    return this.save(config);
  }

  // ---- demo seeding ------------------------------------------------------------------------------

  private ensureSeeded(): Promise<void> {
    this.seeding ??= this.seedIfNeeded();
    return this.seeding;
  }

  private async seedIfNeeded(): Promise<void> {
    let seeded = false;
    try {
      seeded = localStorage.getItem(SEEDED_KEY) === '1';
    } catch {
      // Treated as not seeded; the check below still avoids duplicating existing data.
    }
    let existing = 0;
    try {
      existing = (await dbGetAll<StoredConfig>('configs')).length;
    } catch {
      this.noteMemoryOnly();
    }
    if (seeded && existing > 0) return;
    if (existing === 0 || !seeded) await this.seedSamples(false);
  }

  private async seedSamples(overwrite: boolean): Promise<void> {
    const files = await this.fetchJson<string[]>(`${SAMPLE_DIR}index.json`).catch(() => []);
    for (const file of files) {
      const config = await this.loadSample(file);
      if (!config) continue;
      if (!overwrite && (await this.rawGet(config.id))) continue;
      await this.save(config, file);
    }
    try {
      localStorage.setItem(SEEDED_KEY, '1');
    } catch {
      // Optional.
    }
  }

  private async rawGet(id: string): Promise<StoredConfig | null> {
    try {
      return (await dbGet<StoredConfig>('configs', id)) ?? this.memory.get(id) ?? null;
    } catch {
      return this.memory.get(id) ?? null;
    }
  }

  private async loadSample(file: string): Promise<ProductConfig | null> {
    try {
      const raw = await this.fetchJson<Record<string, unknown>>(`${SAMPLE_DIR}${file}`);
      // Fixtures are written for `configUrl` use; stored copies resolve assets from the app root.
      raw['assetBaseUrl'] = 'assets/';
      const result = validateLocal(raw);
      return result.ok ? (raw as unknown as ProductConfig) : null;
    } catch {
      return null;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(new URL(url, document.baseURI));
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  /** Wipe everything stored by the demo and restore the bundled sample products. */
  async resetDemo(): Promise<void> {
    this.memory.clear();
    try {
      await dbClear('configs');
      await dbClear('assets');
      await dbClear('drafts');
    } catch {
      this.noteMemoryOnly();
    }
    this.seeding = null;
    await this.seedSamples(true);
    this.seeding = Promise.resolve();
  }

  /** Put one sample product back to its shipped state. */
  async restoreSample(id: string): Promise<StoredConfig | null> {
    const stored = await this.get(id);
    if (!stored?.sample) return null;
    const config = await this.loadSample(stored.sample);
    return config ? this.save(config, stored.sample) : null;
  }

  // ---- import / export ---------------------------------------------------------------------------

  /** JSON with browser-stored images embedded as data URLs, so the file is self-contained. */
  async exportJson(config: ProductConfig): Promise<string> {
    const embedded = await mapStrings(structuredClone(config), async (text) => {
      if (!isLocalAssetUrl(text)) return text;
      const blob = await this.library.get(text);
      return blob ? blobToDataUrl(blob) : text;
    });
    return JSON.stringify(embedded, null, 2);
  }

  async importJson(text: string): Promise<ImportResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return {
        ok: false,
        issues: [{ path: '', code: 'json', message: 'The file is not valid JSON.' }],
      };
    }
    const base = resolveBase({ configUrl: null, baseUrl: null, documentBase: document.baseURI });
    const policy = { pageOrigin: location.origin, allowedOrigins: [], allowLocalAssets: true };
    const version =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['schemaVersion']
        : undefined;

    let config: ProductConfig;
    if (version === 1) {
      // Compatibility path: upgrade a version-1 file, keeping its behaviour.
      const result = validateConfig(raw, { resolvedBase: base, policy });
      if (!result.ok) return { ok: false, issues: result.issues };
      config = upgradeV1(result.config);
    } else {
      const result = validateProductConfig(raw, { resolvedBase: base, policy });
      if (!result.ok) return { ok: false, issues: result.issues };
      // Keep the author's relative paths where possible: re-read the raw copy, then re-validate below.
      config = raw as ProductConfig;
    }
    const withAssets = await mapStrings(structuredClone(config), async (value) => {
      if (!value.startsWith('data:image/')) return value;
      const blob = await (await fetch(value)).blob();
      return this.library.put(blob, 'imported');
    });
    const taken = new Set((await this.list()).map((s) => s.id));
    let id = withAssets.id;
    for (let n = 2; taken.has(id); n++) id = `${withAssets.id}-${n}`;
    const final: ProductConfig = { ...withAssets, id };
    const check = validateLocal(final);
    return check.ok ? { ok: true, config: final } : { ok: false, issues: check.issues };
  }

  // ---- assets ----------------------------------------------------------------------------------

  /** Absolute URL for a stored `src` (browser-stored images keep their `idb:` reference). */
  assetUrl(config: ProductConfig, src: string): string {
    if (isLocalAssetUrl(src) || src.startsWith('data:') || /^https?:/i.test(src)) return src;
    return new URL(src, new URL(config.assetBaseUrl ?? '', document.baseURI)).href;
  }

  /** A URL an `<img>` can show for the product's first mockup; call `revoke` when done. */
  async thumbnail(config: ProductConfig): Promise<{ url: string; revoke: () => void } | null> {
    const src = config.mockups[0]?.thumbnail ?? config.mockups[0]?.src;
    if (!src) return null;
    if (isLocalAssetUrl(src)) {
      const blob = await this.library.get(src);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      return { url, revoke: () => URL.revokeObjectURL(url) };
    }
    return { url: this.assetUrl(config, src), revoke: () => undefined };
  }

  private noteMemoryOnly(): void {
    this.storageNote.set(
      'Browser storage is unavailable here, so changes are kept in memory and will be lost on reload.',
    );
  }
}

async function mapStrings<T>(value: T, fn: (text: string) => Promise<string>): Promise<T> {
  if (typeof value === 'string') return (await fn(value)) as unknown as T;
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((item) => mapStrings(item, fn)))) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await mapStrings(item, fn)] as const),
    );
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
