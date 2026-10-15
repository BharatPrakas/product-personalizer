/**
 * IndexedDB access for the standalone app: browser-stored uploads (`assets`), merchant
 * configurations (`configs`) and the last customer draft per configuration (`drafts`). Blobs are
 * stored natively, so images survive reloads without base64 inflation. If IndexedDB is unavailable
 * (some private windows) callers fall back to memory and say so.
 */

export const DB_NAME = 'zb-personalizer';
const DB_VERSION = 1;
export type StoreName = 'assets' | 'configs' | 'drafts';

let opening: Promise<IDBDatabase> | null = null;

export function openLocalDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['assets', 'configs', 'drafts'] as const) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  opening.catch(() => (opening = null));
  return opening;
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function dbGet<T>(store: StoreName, id: string): Promise<T | undefined> {
  const db = await openLocalDb();
  return wrap<T | undefined>(db.transaction(store).objectStore(store).get(id));
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openLocalDb();
  return wrap<T[]>(db.transaction(store).objectStore(store).getAll());
}

export async function dbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function dbDelete(store: StoreName, id: string): Promise<void> {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbClear(store: StoreName): Promise<void> {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
