import { BUNDLED_ASSET_BASE_URL, withCloudAssetBase } from './bundled-assets';

describe('withCloudAssetBase', () => {
  it('replaces the relative default with the bundled CDN base', () => {
    expect(withCloudAssetBase({ assetBaseUrl: 'assets/' }).assetBaseUrl).toBe(BUNDLED_ASSET_BASE_URL);
  });

  it('replaces any other relative value, and a missing one, the same way', () => {
    expect(withCloudAssetBase({ assetBaseUrl: 'my-assets/' }).assetBaseUrl).toBe(BUNDLED_ASSET_BASE_URL);
    expect(withCloudAssetBase<{ assetBaseUrl?: string }>({}).assetBaseUrl).toBe(BUNDLED_ASSET_BASE_URL);
    expect(withCloudAssetBase({ assetBaseUrl: '' }).assetBaseUrl).toBe(BUNDLED_ASSET_BASE_URL);
  });

  it('leaves an already-absolute http(s) value alone (a merchant’s own CDN)', () => {
    const own = 'https://assets.merchant-brand.example/fonts/';
    expect(withCloudAssetBase({ assetBaseUrl: own }).assetBaseUrl).toBe(own);
    expect(withCloudAssetBase({ assetBaseUrl: 'http://localhost:4600/assets/' }).assetBaseUrl).toBe(
      'http://localhost:4600/assets/',
    );
  });

  it('treats a non-http(s) absolute scheme (e.g. idb:/data:) as not resolvable, forcing the CDN base', () => {
    expect(withCloudAssetBase({ assetBaseUrl: 'idb:abc123' }).assetBaseUrl).toBe(BUNDLED_ASSET_BASE_URL);
  });

  it('never mutates the input and leaves every other field untouched', () => {
    const input = { assetBaseUrl: 'assets/', id: 'cfg-1', mockups: [] as unknown[] };
    const result = withCloudAssetBase(input);
    expect(input.assetBaseUrl).toBe('assets/');
    expect(result).not.toBe(input);
    expect(result.id).toBe('cfg-1');
    expect(result.mockups).toBe(input.mockups);
  });
});
