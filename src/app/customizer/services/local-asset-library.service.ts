import { Service } from '@angular/core';
import { uuid } from '../util/ids';
import { dbDelete, dbGet, dbPut } from './local-db';

interface StoredAsset {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  createdAt: number;
}

/**
 * Browser-stored images (merchant mockups, overlays, fixed images) referenced from a configuration
 * as `idb:<id>`. Persisted in IndexedDB; if that is unavailable the session keeps them in memory.
 */
@Service()
export class LocalAssetLibrary {
  private readonly memory = new Map<string, StoredAsset>();

  /** Store `blob` and return its `idb:` reference. */
  async put(blob: Blob, name = 'image'): Promise<string> {
    const id = `a${uuid().replace(/-/g, '').slice(0, 20)}`;
    const record: StoredAsset = { id, blob, name, type: blob.type, createdAt: Date.now() };
    this.memory.set(id, record);
    try {
      await dbPut('assets', record);
    } catch {
      // Kept in memory for this session only.
    }
    return `idb:${id}`;
  }

  /** Store an asset under a fixed id (used when importing a configuration that embeds assets). */
  async putAs(id: string, blob: Blob, name = 'image'): Promise<string> {
    const record: StoredAsset = { id, blob, name, type: blob.type, createdAt: Date.now() };
    this.memory.set(id, record);
    try {
      await dbPut('assets', record);
    } catch {
      // Memory only.
    }
    return `idb:${id}`;
  }

  async get(ref: string): Promise<Blob | null> {
    const id = ref.startsWith('idb:') ? ref.slice(4) : ref;
    const cached = this.memory.get(id);
    if (cached) return cached.blob;
    try {
      const stored = await dbGet<StoredAsset>('assets', id);
      if (stored) {
        this.memory.set(id, stored);
        return stored.blob;
      }
    } catch {
      // Fall through.
    }
    return null;
  }

  async remove(ref: string): Promise<void> {
    const id = ref.startsWith('idb:') ? ref.slice(4) : ref;
    this.memory.delete(id);
    try {
      await dbDelete('assets', id);
    } catch {
      // Nothing to remove.
    }
  }
}
