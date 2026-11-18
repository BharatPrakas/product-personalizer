import { TestBed } from '@angular/core/testing';
import { CustomizationPersistence, PersistKind, UploadedFile } from './customization-persistence.service';
import { DesignPersister, PersistContext } from './design-persister.service';
import type { SavePayload } from './export.service';

const blob = (label: string) => new Blob([label], { type: 'image/png' });

function payload(): SavePayload {
  const preview = { mockupId: 'front', mockupName: 'Front', blob: blob('preview') };
  const artwork = { printableAreaId: 'chest', printableAreaName: 'Chest', artworkId: 'art-1', width: 100, height: 80, blob: blob('artwork') };
  return {
    customization: { schemaVersion: 2 } as unknown as SavePayload['customization'],
    previewBlob: preview.blob,
    artworkBlob: artwork.blob,
    artworks: [artwork],
    previews: [preview],
    assets: [{ assetId: 'photo-1', blob: blob('photo'), mimeType: 'image/png', width: 10, height: 10 }],
  } as SavePayload;
}

const context: PersistContext = {
  target: { apiBaseUrl: 'https://api.example', storeId: 'store-1' },
  productId: 'prod-1',
  variantId: 'white',
  collectionIds: ['summer'],
  templateId: 'tpl',
  templateVersion: 4,
};

describe('DesignPersister', () => {
  const uploads: Array<{ kind: PersistKind; filename?: string; signal: AbortSignal }> = [];
  const creates: Array<{ request: any; signal: AbortSignal }> = [];
  let failUpload: number | null = null;

  function persister(): DesignPersister {
    uploads.length = 0;
    creates.length = 0;
    const fake = {
      async upload(_target: unknown, file: { kind: PersistKind; filename?: string }, signal: AbortSignal): Promise<UploadedFile> {
        if (failUpload === uploads.length) throw new Error('upload failed');
        uploads.push({ kind: file.kind, filename: file.filename, signal });
        return { assetId: `asset-${uploads.length}`, uploadToken: `tok-${uploads.length}` };
      },
      async create(_target: unknown, request: unknown, signal: AbortSignal) {
        creates.push({ request, signal });
        return { customizationId: 'cz-9', accessToken: 'secret', expiresAt: '2030-01-01T00:00:00Z' };
      },
    };
    TestBed.configureTestingModule({ providers: [DesignPersister, { provide: CustomizationPersistence, useValue: fake }] });
    return TestBed.inject(DesignPersister);
  }

  beforeEach(() => {
    failUpload = null;
    TestBed.resetTestingModule();
  });

  it('uploads the photos, then the artwork, then the previews, then creates the customization that references them', async () => {
    const signal = new AbortController().signal;
    const created = await persister().persist(context, payload(), signal);
    expect(created.customizationId).toBe('cz-9');
    expect(uploads.map((u) => [u.kind, u.filename])).toEqual([
      ['upload', 'photo-1'],
      ['artwork', 'chest'],
      ['preview', 'front'],
    ]);
    expect(creates).toHaveLength(1);
    const { request } = creates[0];
    expect(request).toMatchObject({
      productId: 'prod-1',
      variantId: 'white',
      collectionIds: ['summer'],
      configId: 'tpl',
      configVersion: 4,
      assets: [
        { assetId: 'asset-1', uploadToken: 'tok-1' },
        { assetId: 'asset-2', uploadToken: 'tok-2' },
        { assetId: 'asset-3', uploadToken: 'tok-3' },
      ],
    });
    // The data says which stored file is which.
    expect(request.data).toEqual({
      schema: 1,
      template: { id: 'tpl', version: 4 },
      customization: { schemaVersion: 2 },
      files: {
        uploads: [{ assetId: 'photo-1', ref: 'asset-1', mimeType: 'image/png', width: 10, height: 10 }],
        artworks: [{ printableAreaId: 'chest', artworkId: 'art-1', width: 100, height: 80, ref: 'asset-2' }],
        previews: [{ mockupId: 'front', ref: 'asset-3' }],
      },
    });
  });

  it('hands the abort signal to every call', async () => {
    const controller = new AbortController();
    await persister().persist(context, payload(), controller.signal);
    expect([...uploads.map((u) => u.signal), creates[0].signal].every((s) => s === controller.signal)).toBe(true);
  });

  it('never creates a customization from a partial upload', async () => {
    const instance = persister();
    failUpload = 1; // the second file fails
    await expect(instance.persist(context, payload(), new AbortController().signal)).rejects.toThrow('upload failed');
    expect(creates).toHaveLength(0);
  });
});
