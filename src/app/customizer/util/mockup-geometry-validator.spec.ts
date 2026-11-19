import { describe, expect, it } from 'vitest';
import { validateProductConfig } from './product-validator';
import { resolveBase } from './url-policy';

const options = (allowLocalAssets = false) => ({
  resolvedBase: resolveBase({
    configUrl: null,
    baseUrl: 'https://shop.example/base/',
    documentBase: 'https://shop.example/',
  }),
  policy: { pageOrigin: 'https://shop.example', allowedOrigins: [], allowLocalAssets },
});

type Json = Record<string, unknown>;

function config(placement: Json = {}): Json {
  return {
    schemaVersion: 2,
    id: 'cfg',
    version: 1,
    status: 'published',
    product: { id: 'p', name: 'Bottle' },
    assetBaseUrl: 'assets/',
    variants: [{ id: 'v', label: 'Default', mockupIds: ['m'], printableAreaIds: ['a'] }],
    mockups: [
      {
        id: 'm',
        name: 'Front',
        src: 'mockups/front.jpg',
        placements: [
          {
            printableAreaId: 'a',
            type: 'rect',
            x: 0.2,
            y: 0.3,
            width: 0.5,
            height: 0.3,
            ...placement,
          },
        ],
      },
    ],
    printableAreas: [
      {
        id: 'a',
        name: 'Label',
        enabled: true,
        canvas: { width: 800, height: 400, background: 'transparent' },
        shape: { type: 'rect' },
        artworkId: 'w',
        artworkIds: ['w'],
      },
    ],
    artworks: [
      {
        id: 'w',
        name: 'Art',
        printableAreaId: 'a',
        layers: [
          {
            id: 'note-layer',
            type: 'text',
            fieldId: 'note',
            x: 10,
            y: 10,
            width: 120,
            height: 40,
            fontSize: 24,
            minFontSize: 12,
            align: 'left',
          },
        ],
      },
    ],
    fonts: [
      { id: 'sans', family: 'CustomizerSans', label: 'Sans', src: 'fonts/sans-regular.woff2' },
    ],
    fields: [
      {
        id: 'note',
        type: 'text',
        label: 'Note',
        required: false,
        maxLength: 10,
        fontIds: ['sans'],
        colors: ['#000000'],
        printableAreaId: 'a',
        artworkId: 'w',
        defaultValue: { text: '', fontId: 'sans', color: '#000000' },
      },
    ],
  };
}

const tri = (extra: Json = {}) => ({
  version: 1,
  fillRule: 'nonzero',
  contours: [
    {
      anchors: [
        { x: 0.2, y: 0.3 },
        { x: 0.7, y: 0.3 },
        { x: 0.45, y: 0.6 },
      ],
    },
  ],
  ...extra,
});
const cyl = {
  type: 'cylinder',
  curvature: 140,
  centre: 0,
  visibleLeft: 90,
  visibleRight: 90,
  tilt: 0,
};
const mesh = (cols: number, rows: number, tweak?: (points: number[]) => void) => {
  const points: number[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) points.push(i / (cols - 1), j / (rows - 1));
  tweak?.(points);
  return { cols, rows, points };
};

const issues = (placement: Json, allowLocal = false) => {
  const r = validateProductConfig(config(placement), options(allowLocal));
  return r.ok ? [] : r.issues;
};
const codes = (placement: Json) => issues(placement).map((i) => `${i.path}:${i.code}`);

describe('existing configurations are unaffected', () => {
  it('accepts a plain rect and quad placement exactly as before', () => {
    expect(issues({})).toEqual([]);
    expect(
      issues({
        type: 'quad',
        corners: [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
      }),
    ).toEqual([]);
  });

  it('does not add the new fields to a plain placement', () => {
    const r = validateProductConfig(config(), options());
    expect(r.ok && Object.keys(r.config.mockups[0].placements[0])).toEqual([
      'printableAreaId',
      'type',
      'x',
      'y',
      'width',
      'height',
    ]);
  });
});

describe('Bezier boundary', () => {
  it('accepts a closed path and keeps its geometry verbatim', () => {
    const path = tri({ fillRule: 'evenodd' });
    path.contours[0].anchors[1] = {
      x: 0.7,
      y: 0.3,
      handleIn: [0.5, 0.25],
      handleOut: [0.8, 0.35],
      smooth: true,
    } as never;
    const r = validateProductConfig(config({ mask: { type: 'path', path } }), options());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.mockups[0].placements[0].mask).toEqual({ type: 'path', path });
  });

  it('accepts several contours (a hole) and both fill rules', () => {
    const hole = {
      anchors: [
        { x: 0.3, y: 0.35 },
        { x: 0.4, y: 0.35 },
        { x: 0.35, y: 0.4 },
      ],
    };
    for (const fillRule of ['nonzero', 'evenodd']) {
      expect(
        issues({
          mask: { type: 'path', path: tri({ fillRule, contours: [tri().contours[0], hole] }) },
        }),
      ).toEqual([]);
    }
  });

  it.each([
    ['unknown version', tri({ version: 2 }), 'version'],
    ['unknown fill rule', tri({ fillRule: 'winding' }), 'fillRule'],
    ['no contours', tri({ contours: [] }), 'contours'],
    [
      'a contour with two anchors',
      tri({
        contours: [
          {
            anchors: [
              { x: 0.1, y: 0.1 },
              { x: 0.5, y: 0.5 },
            ],
          },
        ],
      }),
      'anchors',
    ],
    [
      'NaN coordinate',
      tri({
        contours: [
          {
            anchors: [
              { x: NaN, y: 0.1 },
              { x: 0.5, y: 0.5 },
              { x: 0.2, y: 0.9 },
            ],
          },
        ],
      }),
      'x',
    ],
    [
      'Infinity coordinate',
      tri({
        contours: [
          {
            anchors: [
              { x: 0.1, y: Infinity },
              { x: 0.5, y: 0.5 },
              { x: 0.2, y: 0.9 },
            ],
          },
        ],
      }),
      'y',
    ],
    [
      'coordinate far off the photo',
      tri({
        contours: [
          {
            anchors: [
              { x: 90, y: 0.1 },
              { x: 0.5, y: 0.5 },
              { x: 0.2, y: 0.9 },
            ],
          },
        ],
      }),
      'x',
    ],
    [
      'a malformed handle',
      tri({
        contours: [
          {
            anchors: [
              { x: 0.1, y: 0.1, handleOut: [0.2] },
              { x: 0.5, y: 0.5 },
              { x: 0.2, y: 0.9 },
            ],
          },
        ],
      }),
      'handleOut',
    ],
    [
      'an unknown anchor property',
      tri({
        contours: [
          {
            anchors: [
              { x: 0.1, y: 0.1, bogus: 1 },
              { x: 0.5, y: 0.5 },
              { x: 0.2, y: 0.9 },
            ],
          },
        ],
      }),
      'bogus',
    ],
  ])('rejects %s', (_name, path, where) => {
    const found = issues({ mask: { type: 'path', path } });
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((i) => i.path.includes(where))).toBe(true);
  });

  it('rejects a degenerate (collinear) contour', () => {
    const flat = tri({
      contours: [
        {
          anchors: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.5 },
            { x: 0.9, y: 0.9 },
          ],
        },
      ],
    });
    expect(codes({ mask: { type: 'path', path: flat } })).toContain(
      'mockups[0].placements[0].mask.path.contours[0]:degenerate',
    );
  });

  it('rejects too many anchors per contour and in total, and too many contours', () => {
    const ring = (n: number) => ({
      anchors: Array.from({ length: n }, (_, i) => ({
        x: 0.5 + 0.4 * Math.cos((i / n) * 2 * Math.PI),
        y: 0.5 + 0.4 * Math.sin((i / n) * 2 * Math.PI),
      })),
    });
    expect(
      issues({ mask: { type: 'path', path: tri({ contours: [ring(300)] }) } }).length,
    ).toBeGreaterThan(0);
    expect(
      issues({
        mask: { type: 'path', path: tri({ contours: Array.from({ length: 17 }, () => ring(8)) }) },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      issues({
        mask: { type: 'path', path: tri({ contours: Array.from({ length: 6 }, () => ring(200)) }) },
      }).some((i) => i.message.includes('in total')),
    ).toBe(true);
  });

  it('accepts a self-intersecting contour (it is filled by the fill rule)', () => {
    const bowTie = tri({
      contours: [
        {
          anchors: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.9 },
            { x: 0.9, y: 0.1 },
            { x: 0.1, y: 0.9 },
          ],
        },
      ],
    });
    expect(issues({ mask: { type: 'path', path: bowTie } })).toEqual([]);
  });
});

describe('raster boundary', () => {
  const raster = { type: 'raster', src: 'masks/m.png', width: 1000, height: 800 };

  it('resolves the mask image like any other asset (absolute URL, policy applied)', () => {
    const r = validateProductConfig(config({ mask: raster }), options());
    expect(r.ok && r.config.mockups[0].placements[0].mask).toEqual({
      ...raster,
      src: 'https://shop.example/base/assets/masks/m.png',
    });
  });

  it('rejects hostile or malformed sources and sizes', () => {
    expect(issues({ mask: { ...raster, src: 'javascript:alert(1)' } }).length).toBeGreaterThan(0);
    expect(
      issues({ mask: { ...raster, src: 'data:image/png;base64,AAAA' } }).length,
    ).toBeGreaterThan(0);
    expect(issues({ mask: { ...raster, src: 'file:///etc/passwd' } }).length).toBeGreaterThan(0);
    expect(issues({ mask: { ...raster, src: '../../secret.png' } }).length).toBeGreaterThan(0);
    expect(issues({ mask: { ...raster, width: 0 } }).length).toBeGreaterThan(0);
    expect(issues({ mask: { ...raster, width: 5000 } }).length).toBeGreaterThan(0);
    expect(issues({ mask: { ...raster, height: 10.5 } }).length).toBeGreaterThan(0);
    expect(issues({ mask: { type: 'blob', src: 'x' } }).length).toBeGreaterThan(0);
  });

  it('accepts a browser-stored mask in the standalone app only', () => {
    expect(issues({ mask: { ...raster, src: 'idb:abc123' } }, true)).toEqual([]);
    expect(issues({ mask: { ...raster, src: 'idb:abc123' } }, false).length).toBeGreaterThan(0);
  });
});

describe('cylinder surface', () => {
  it('accepts valid parameters, on a rect and on a perspective quad', () => {
    expect(issues({ surface: cyl })).toEqual([]);
    expect(
      issues({
        type: 'quad',
        corners: [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
        surface: cyl,
      }),
    ).toEqual([]);
  });

  it.each([
    ['curvature above 360', { ...cyl, curvature: 361 }],
    ['negative curvature', { ...cyl, curvature: -1 }],
    ['visible extent 0', { ...cyl, visibleLeft: 0 }],
    ['visible extent above 90', { ...cyl, visibleRight: 91 }],
    ['tilt above 60', { ...cyl, tilt: 61 }],
    ['centre out of range', { ...cyl, centre: 200 }],
    ['NaN curvature', { ...cyl, curvature: NaN }],
    ['unknown type', { ...cyl, type: 'cone' }],
    ['a missing parameter', { type: 'cylinder', curvature: 100 }],
    ['an unknown parameter', { ...cyl, radius: 3 }],
  ])('rejects %s', (_name, surface) => {
    expect(issues({ surface }).length).toBeGreaterThan(0);
  });
});

describe('mesh', () => {
  it('accepts valid meshes from 2x2 to 12x12', () => {
    expect(issues({ mesh: mesh(2, 2) })).toEqual([]);
    expect(issues({ mesh: mesh(5, 4) })).toEqual([]);
    expect(issues({ mesh: mesh(12, 12) })).toEqual([]);
  });

  it('can be combined with a boundary and a surface', () => {
    expect(issues({ mesh: mesh(4, 4), surface: cyl, mask: { type: 'path', path: tri() } })).toEqual(
      [],
    );
  });

  it.each([
    ['too few columns', mesh(1, 3)],
    ['too many rows', mesh(3, 13)],
    ['a wrong point count', { cols: 3, rows: 3, points: [0, 0, 1, 1] }],
    ['non-integer density', { ...mesh(3, 3), cols: 2.5 }],
    [
      'NaN point',
      mesh(3, 3, (p) => {
        p[4] = NaN;
      }),
    ],
    [
      'a point far off the frame',
      mesh(3, 3, (p) => {
        p[4] = 40;
      }),
    ],
    ['an unknown property', { ...mesh(3, 3), extra: true }],
  ])('rejects %s', (_name, m) => {
    expect(issues({ mesh: m }).length).toBeGreaterThan(0);
  });

  it('rejects a folded mesh and a collapsed cell', () => {
    // Drag the centre point of a 3x3 mesh past the left edge: the surface turns inside out.
    const folded = mesh(3, 3, (p) => {
      p[8] = -0.4;
    });
    expect(codes({ mesh: folded })).toContain('mockups[0].placements[0].mesh:folded');
    const collapsed = mesh(3, 3, (p) => {
      p[2] = 0;
      p[3] = 0;
      p[6] = 0;
      p[7] = 0.5;
      p[0] = 0;
      p[1] = 0;
    });
    expect(issues({ mesh: collapsed }).length).toBeGreaterThan(0);
  });
});
