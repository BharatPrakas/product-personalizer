import { checkAssetSrc, checkHostAssetUrl, resolveAssetDir, resolveBase } from './url-policy';

const policy = { pageOrigin: 'https://shop.example', allowedOrigins: [] as string[] };

describe('resolveBase (F01 / section 8)', () => {
  it('resolves assetBaseUrl against the absolute config URL for configUrl', () => {
    const base = resolveBase({
      configUrl: '/customizer/data/tote.json',
      baseUrl: 'https://ignored.example/',
      documentBase: 'https://shop.example/store/page.html',
    });
    expect(base.configUrl).toBe('https://shop.example/customizer/data/tote.json');
    const dir = resolveAssetDir('../assets/', base, policy);
    expect(dir).toEqual({ ok: true, url: 'https://shop.example/customizer/assets/' });
  });

  it('works under a nested base path and never assumes the host root is "/"', () => {
    const base = resolveBase({
      configUrl: 'data/tote.json',
      baseUrl: null,
      documentBase: 'https://shop.example/a/b/c/index.html',
    });
    expect(base.configUrl).toBe('https://shop.example/a/b/c/data/tote.json');
    const dir = resolveAssetDir('../assets', base, policy);
    expect(dir).toEqual({ ok: true, url: 'https://shop.example/a/b/c/assets/' });
    const asset = checkAssetSrc('clipart/star.png', (dir as { url: string }).url, policy);
    expect(asset).toEqual({ ok: true, url: 'https://shop.example/a/b/c/assets/clipart/star.png' });
  });

  it('object configuration resolves against baseUrl, treating it as a directory', () => {
    const base = resolveBase({
      configUrl: null,
      baseUrl: 'https://cdn.example/customizer',
      documentBase: 'https://shop.example/',
    });
    expect(base.defaultAssetDir).toBe('https://cdn.example/customizer/');
    expect(resolveAssetDir(undefined, base, policy)).toEqual({
      ok: true,
      url: 'https://cdn.example/customizer/',
    });
  });

  it('object configuration falls back to the document base', () => {
    const base = resolveBase({
      configUrl: null,
      baseUrl: null,
      documentBase: 'https://shop.example/store/product.html',
    });
    expect(base.defaultAssetDir).toBe('https://shop.example/store/');
  });

  it('adds the trailing slash an asset directory needs', () => {
    const base = resolveBase({
      configUrl: 'https://shop.example/c/data/x.json',
      baseUrl: null,
      documentBase: 'https://shop.example/',
    });
    expect(resolveAssetDir('assets', base, policy)).toEqual({
      ok: true,
      url: 'https://shop.example/c/data/assets/',
    });
  });
});

describe('checkAssetSrc', () => {
  const base = 'https://shop.example/customizer/assets/';

  it('allows absolute http(s) URLs on other origins when no allow-list is set', () => {
    expect(checkAssetSrc('https://cdn.example/a.png', base, policy)).toEqual({
      ok: true,
      url: 'https://cdn.example/a.png',
    });
    expect(checkAssetSrc('//cdn.example/a.png', base, policy)).toEqual({
      ok: true,
      url: 'https://cdn.example/a.png',
    });
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>',
    'vbscript:x',
    'blob:https://x/y',
    'file:///etc/hosts',
  ])('rejects executable or inline scheme %s', (src) => {
    const result = checkAssetSrc(src, base, policy);
    expect(result.ok).toBe(false);
  });

  it('rejects empty, oversized and control-character URLs', () => {
    expect(checkAssetSrc('', base, policy).ok).toBe(false);
    expect(checkAssetSrc('a'.repeat(3000), base, policy).ok).toBe(false);
    expect(checkAssetSrc('a\nb.png', base, policy).ok).toBe(false);
    expect(checkAssetSrc(42, base, policy).ok).toBe(false);
  });

  it('allows ".." only where explicitly permitted (the asset base itself)', () => {
    expect(checkAssetSrc('../x.png', base, policy).ok).toBe(false);
    expect(checkAssetSrc('../x.png', base, policy, { allowParentSegments: true })).toEqual({
      ok: true,
      url: 'https://shop.example/customizer/x.png',
    });
  });
});

describe('checkAssetSrc: hardening', () => {
  const base = 'https://shop.example/customizer/assets/dir/';

  it.each([' ../x.png', '../x.png ', '.. ', '\t../x.png', ' //evil.example/x.png', 'x.png '])(
    'rejects %j: URL parsing would silently trim it and bypass the ".." check',
    (src) => {
      const result = checkAssetSrc(src, base, policy);
      expect(result.ok).toBe(false);
    },
  );

  it('normalises host-supplied origins (case, trailing slash, path) before comparing', () => {
    const allow = (origins: string[]) => ({
      pageOrigin: 'https://shop.example',
      allowedOrigins: origins,
    });
    const asset = 'https://cdn.example.com/a.png';
    for (const entry of [
      'https://cdn.example.com',
      'https://cdn.example.com/',
      'HTTPS://CDN.EXAMPLE.COM',
      'https://cdn.example.com/some/path',
    ]) {
      expect(checkAssetSrc(asset, base, allow([entry])).ok, entry).toBe(true);
    }
    expect(checkAssetSrc(asset, base, allow(['https://other.example/'])).ok).toBe(false);
    expect(checkAssetSrc(asset, base, allow(['not a url'])).ok).toBe(false);
  });
});

describe('checkHostAssetUrl (assetMap)', () => {
  it('accepts http(s) and host-created blob URLs only', () => {
    expect(checkHostAssetUrl('https://cdn.example/a.png', 'https://shop.example/').ok).toBe(true);
    expect(checkHostAssetUrl('blob:https://shop.example/1234', 'https://shop.example/').ok).toBe(
      true,
    );
    expect(checkHostAssetUrl('javascript:alert(1)', 'https://shop.example/').ok).toBe(false);
    expect(checkHostAssetUrl('data:image/png;base64,AAAA', 'https://shop.example/').ok).toBe(false);
  });
});
