import { describe, expect, it } from 'vitest';
import type { BezierAnchor, BezierContour, BezierPath } from '../models/product.models';
import {
  bezierBounds,
  bezierToSvgPath,
  contourArea,
  contourSelfIntersects,
  cubicAt,
  flattenContour,
  isDegenerateContour,
  pointInBezierPath,
  polygonArea,
  segmentPoints,
} from './bezier';

const corner = (x: number, y: number): BezierAnchor => ({ x, y });
const square = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  clockwise = true,
): BezierContour => {
  const pts = clockwise
    ? [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)]
    : [corner(x0, y0), corner(x0, y1), corner(x1, y1), corner(x1, y0)];
  return { anchors: pts };
};
const path = (fillRule: BezierPath['fillRule'], ...contours: BezierContour[]): BezierPath => ({
  version: 1,
  fillRule,
  contours,
});

/** Four smooth anchors approximating a circle (the classic 0.5523 handle length). */
function circle(cx: number, cy: number, r: number): BezierContour {
  const k = 0.5522847498 * r;
  return {
    anchors: [
      { x: cx, y: cy - r, handleIn: [cx - k, cy - r], handleOut: [cx + k, cy - r], smooth: true },
      { x: cx + r, y: cy, handleIn: [cx + r, cy - k], handleOut: [cx + r, cy + k], smooth: true },
      { x: cx, y: cy + r, handleIn: [cx + k, cy + r], handleOut: [cx - k, cy + r], smooth: true },
      { x: cx - r, y: cy, handleIn: [cx - r, cy + k], handleOut: [cx - r, cy - k], smooth: true },
    ],
  };
}

describe('bezier construction', () => {
  it('builds a straight segment from anchors without handles', () => {
    const [p0, p1, p2, p3] = segmentPoints(corner(0.1, 0.2), corner(0.5, 0.6));
    expect(p0).toEqual([0.1, 0.2]);
    expect(p1).toEqual([0.1, 0.2]);
    expect(p2).toEqual([0.5, 0.6]);
    expect(p3).toEqual([0.5, 0.6]);
  });

  it('evaluates a cubic at its ends and midpoint', () => {
    const p = segmentPoints({ x: 0, y: 0, handleOut: [0, 1] }, { x: 1, y: 0, handleIn: [1, 1] });
    expect(cubicAt(p, 0)).toEqual([0, 0]);
    expect(cubicAt(p, 1)).toEqual([1, 0]);
    const [mx, my] = cubicAt(p, 0.5);
    expect(mx).toBeCloseTo(0.5, 10);
    expect(my).toBeCloseTo(0.75, 10); // 3/4 of the control height
  });

  it('flattens straight contours to their anchors only', () => {
    expect(flattenContour(square(0, 0, 1, 1))).toHaveLength(4);
  });

  it('keeps a flattened circle within the tolerance of the true circle', () => {
    const poly = flattenContour(circle(0.5, 0.5, 0.3), 1000, 0.25);
    expect(poly.length).toBeGreaterThan(16);
    for (const [x, y] of poly) {
      // The 4-anchor Bezier circle itself deviates ~0.027 % of the radius from the ideal one.
      expect(Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.3)).toBeLessThan(0.3 * 0.0006);
    }
    expect(polygonArea(poly)).toBeCloseTo(Math.PI * 0.09, 3);
  });
});

describe('fill rules, holes and multiple contours', () => {
  it('classifies points of a straight-sided triangle', () => {
    const p = path('nonzero', {
      anchors: [corner(0.2, 0.2), corner(0.8, 0.2), corner(0.5, 0.8)],
    });
    expect(pointInBezierPath(p, [0.5, 0.4])).toBe(true);
    expect(pointInBezierPath(p, [0.1, 0.1])).toBe(false);
    expect(pointInBezierPath(p, [0.5, 0.9])).toBe(false);
  });

  it('curved segments bulge outwards past the chord', () => {
    const lens = path('nonzero', {
      anchors: [
        { x: 0.2, y: 0.5, handleOut: [0.2, 0.1] },
        { x: 0.8, y: 0.5, handleIn: [0.8, 0.1] },
        { x: 0.5, y: 0.9 },
      ],
    });
    // Above the chord y = 0.5 only the curved top edge can enclose this point.
    expect(pointInBezierPath(lens, [0.5, 0.3])).toBe(true);
    expect(pointInBezierPath(lens, [0.5, 0.05])).toBe(false);
  });

  it('a contour wound the opposite way is a hole under non-zero', () => {
    const p = path('nonzero', square(0.1, 0.1, 0.9, 0.9), square(0.4, 0.4, 0.6, 0.6, false));
    expect(pointInBezierPath(p, [0.2, 0.2])).toBe(true);
    expect(pointInBezierPath(p, [0.5, 0.5])).toBe(false);
  });

  it('the same winding fills the inner contour under non-zero but cuts a hole under even-odd', () => {
    const outer = square(0.1, 0.1, 0.9, 0.9);
    const inner = square(0.4, 0.4, 0.6, 0.6);
    expect(pointInBezierPath(path('nonzero', outer, inner), [0.5, 0.5])).toBe(true);
    expect(pointInBezierPath(path('evenodd', outer, inner), [0.5, 0.5])).toBe(false);
    expect(pointInBezierPath(path('evenodd', outer, inner), [0.2, 0.2])).toBe(true);
  });

  it('supports disconnected contours', () => {
    const p = path('nonzero', square(0.05, 0.05, 0.3, 0.3), square(0.6, 0.6, 0.9, 0.9));
    expect(pointInBezierPath(p, [0.15, 0.15])).toBe(true);
    expect(pointInBezierPath(p, [0.75, 0.75])).toBe(true);
    expect(pointInBezierPath(p, [0.45, 0.45])).toBe(false);
  });
});

describe('self-intersecting contours', () => {
  const pentagram: BezierContour = {
    anchors: [0, 2, 4, 1, 3].map((k) => {
      const angle = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      return corner(0.5 + 0.4 * Math.cos(angle), 0.5 + 0.4 * Math.sin(angle));
    }),
  };
  const bowTie: BezierContour = {
    anchors: [corner(0.1, 0.1), corner(0.9, 0.9), corner(0.9, 0.1), corner(0.1, 0.9)],
  };

  it('detects crossings and not simple shapes', () => {
    expect(contourSelfIntersects(pentagram)).toBe(true);
    expect(contourSelfIntersects(bowTie)).toBe(true);
    expect(contourSelfIntersects(square(0, 0, 1, 1))).toBe(false);
    expect(contourSelfIntersects(circle(0.5, 0.5, 0.3))).toBe(false);
  });

  it('is filled according to the fill rule: the pentagram centre is in under non-zero only', () => {
    expect(pointInBezierPath(path('nonzero', pentagram), [0.5, 0.5])).toBe(true);
    expect(pointInBezierPath(path('evenodd', pentagram), [0.5, 0.5])).toBe(false);
    // A point in one of the star's arms is inside under both rules.
    expect(pointInBezierPath(path('nonzero', pentagram), [0.5, 0.15])).toBe(true);
    expect(pointInBezierPath(path('evenodd', pentagram), [0.5, 0.15])).toBe(true);
  });

  it('a bow-tie has two filled lobes meeting at the crossing under both rules', () => {
    for (const rule of ['nonzero', 'evenodd'] as const) {
      const p = path(rule, bowTie);
      expect(pointInBezierPath(p, [0.25, 0.5])).toBe(true); // left lobe
      expect(pointInBezierPath(p, [0.75, 0.5])).toBe(true); // right lobe
      expect(pointInBezierPath(p, [0.5, 0.2])).toBe(false); // the open wedge above the crossing
      expect(pointInBezierPath(p, [0.5, 0.8])).toBe(false); // ... and below it
    }
  });
});

describe('measurements and conversion', () => {
  it('computes areas and bounds', () => {
    expect(contourArea(square(0.2, 0.2, 0.6, 0.7))).toBeCloseTo(0.2, 10);
    const b = bezierBounds(path('nonzero', square(0.2, 0.3, 0.6, 0.7)));
    expect(b).toEqual({
      x: 0.2,
      y: 0.3,
      width: expect.closeTo(0.4, 10),
      height: expect.closeTo(0.4, 10),
    });
    expect(bezierBounds(path('nonzero'))).toBeNull();
  });

  it('calls collinear and coincident contours degenerate', () => {
    expect(isDegenerateContour({ anchors: [corner(0, 0), corner(0.5, 0.5), corner(1, 1)] })).toBe(
      true,
    );
    expect(
      isDegenerateContour({ anchors: [corner(0.3, 0.3), corner(0.3, 0.3), corner(0.3, 0.3)] }),
    ).toBe(true);
    expect(isDegenerateContour(square(0.1, 0.1, 0.5, 0.5))).toBe(false);
    // A bow-tie's signed area is zero (the lobes cancel) but it is a real shape.
    expect(
      isDegenerateContour({
        anchors: [corner(0.1, 0.1), corner(0.9, 0.9), corner(0.9, 0.1), corner(0.1, 0.9)],
      }),
    ).toBe(false);
  });

  it('writes SVG path data fitted to a box', () => {
    const d = bezierToSvgPath(path('nonzero', square(0.2, 0.2, 0.6, 0.6)), {
      x: 0.2,
      y: 0.2,
      width: 0.4,
      height: 0.4,
    });
    expect(d).toBe('M0 0L1 0L1 1L0 1Z');
    const curved = bezierToSvgPath(
      path('nonzero', {
        anchors: [{ x: 0, y: 0, handleOut: [0.5, 0] }, corner(1, 0), corner(0.5, 1)],
      }),
      { x: 0, y: 0, width: 1, height: 1 },
    );
    expect(curved).toContain('C0.5 0 1 0 1 0');
  });
});
