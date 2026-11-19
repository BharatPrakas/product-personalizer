import Ajv2020 from 'ajv/dist/2020';
import bottleJson from '../../../../public/data/products/bottle.json';
import heartClockJson from '../../../../public/data/products/heart-clock.json';
import tshirtJson from '../../../../public/data/products/tshirt.json';
import schema from '../../../../public/schema/product-config.schema.json';
import { validateProductConfig } from './product-validator';
import { resolveBase } from './url-policy';

const runtime = (raw: unknown) =>
  validateProductConfig(raw, {
    resolvedBase: resolveBase({
      configUrl: null,
      baseUrl: 'https://shop.example/base/',
      documentBase: 'https://shop.example/',
    }),
    policy: { pageOrigin: 'https://shop.example', allowedOrigins: [], allowLocalAssets: false },
  });

describe('product-config.schema.json (placement geometry)', () => {
  let check: ReturnType<Ajv2020['compile']>;
  beforeAll(() => {
    // Not strict: the committed schema predates this test and trips ajv's strictRequired / strictTypes in
    // places unrelated to placement geometry (it was never compiled by any test before).
    check = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  });

  const samples: [string, unknown][] = [
    ['bottle', bottleJson],
    ['heart-clock', heartClockJson],
    ['tshirt', tshirtJson],
  ];

  it.each(samples)(
    'the shipped %s sample satisfies the schema and the runtime validator',
    (_name, json) => {
      expect(check(json), JSON.stringify(check.errors)).toBe(true);
      expect(runtime({ ...(json as object), assetBaseUrl: 'assets/' }).ok).toBe(true);
    },
    30_000,
  );

  const triangle = {
    version: 1,
    fillRule: 'nonzero',
    contours: [
      {
        anchors: [
          { x: 0.3, y: 0.5 },
          { x: 0.7, y: 0.5 },
          { x: 0.5, y: 0.8, handleIn: [0.55, 0.78], handleOut: [0.45, 0.78], smooth: true },
        ],
      },
    ],
  };
  const cylinder = {
    type: 'cylinder',
    curvature: 140,
    centre: 0,
    visibleLeft: 90,
    visibleRight: 90,
    tilt: 0,
  };
  const mesh = { cols: 2, rows: 2, points: [0, 0, 1, 0, 0, 1, 1, 1] };

  const withPlacement = (patch: Record<string, unknown>) => {
    const config = structuredClone(bottleJson) as any;
    config.assetBaseUrl = 'assets/';
    Object.assign(config.mockups[0].placements[0], patch);
    return config;
  };

  it('accepts a boundary, a surface and a mesh', () => {
    for (const patch of [
      { mask: { type: 'path', path: triangle } },
      { mask: { type: 'raster', src: 'masks/m.png', width: 1000, height: 800 } },
      { surface: cylinder },
      { mesh },
      { mask: { type: 'path', path: triangle }, surface: cylinder },
    ]) {
      const config = withPlacement(patch);
      expect(check(config), JSON.stringify(check.errors)).toBe(true);
      expect(runtime(config).ok, JSON.stringify(patch).slice(0, 80)).toBe(true);
    }
  }, 30_000);

  it('the schema and the runtime validator reject the same structural mistakes', () => {
    const bad: Record<string, unknown>[] = [
      { mask: { type: 'path', path: { ...triangle, version: 2 } } },
      { mask: { type: 'path', path: { ...triangle, fillRule: 'winding' } } },
      { mask: { type: 'path', path: { ...triangle, contours: [] } } },
      {
        mask: {
          type: 'path',
          path: {
            ...triangle,
            contours: [
              {
                anchors: [
                  { x: 0, y: 0 },
                  { x: 1, y: 1 },
                ],
              },
            ],
          },
        },
      },
      { mask: { type: 'raster', src: 'masks/m.png', width: 0, height: 10 } },
      { mask: { type: 'raster', src: 'masks/m.png', width: 5000, height: 10 } },
      { mask: { type: 'blob' } },
      { surface: { ...cylinder, curvature: 400 } },
      { surface: { ...cylinder, visibleLeft: 0 } },
      { surface: { ...cylinder, tilt: 90 } },
      { surface: { ...cylinder, extra: 1 } },
      { mesh: { cols: 1, rows: 2, points: [0, 0, 1, 1] } },
      { mesh: { cols: 13, rows: 2, points: [] } },
      { mesh: { ...mesh, points: [0, 0, 1, 0, 0, 1, 1, 99] } },
    ];
    for (const patch of bad) {
      const config = withPlacement(patch);
      expect(check(config), JSON.stringify(patch).slice(0, 80)).toBe(false);
      expect(runtime(config).ok, JSON.stringify(patch).slice(0, 80)).toBe(false);
    }
  }, 30_000);
});
