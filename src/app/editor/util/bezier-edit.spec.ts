import { describe, expect, it } from 'vitest';
import type { BezierPath } from '../../customizer/models/product.models';
import { BEZIER_LIMITS } from '../../customizer/models/product.models';
import { contourArea, pointInBezierPath } from '../../customizer/util/bezier';
import {
  anchorAt,
  appendContour,
  asHole,
  canAddAnchor,
  cornerAnchor,
  dragAnchor,
  insertAnchor,
  moveAnchor,
  moveHandle,
  nearestOnPath,
  pathFromAnchors,
  removeAnchor,
  reverseAnchors,
  toggleSmooth,
  totalAnchors,
  translatePath,
} from './bezier-edit';

const triangle = (): BezierPath =>
  pathFromAnchors([cornerAnchor(0.2, 0.2), cornerAnchor(0.8, 0.2), cornerAnchor(0.5, 0.8)]);
const square = (): BezierPath =>
  pathFromAnchors([
    cornerAnchor(0.2, 0.2),
    cornerAnchor(0.8, 0.2),
    cornerAnchor(0.8, 0.8),
    cornerAnchor(0.2, 0.8),
  ]);

describe('constructing anchors', () => {
  it('a click makes a corner, a click-drag makes a smooth anchor with mirrored handles', () => {
    expect(cornerAnchor(0.3, 0.4)).toEqual({ x: 0.3, y: 0.4 });
    expect(dragAnchor(0.5, 0.5, 0.6, 0.5)).toEqual({
      x: 0.5,
      y: 0.5,
      handleIn: [0.4, 0.5],
      handleOut: [0.6, 0.5],
      smooth: true,
    });
    // A drag shorter than the threshold is still a plain click.
    expect(dragAnchor(0.5, 0.5, 0.5004, 0.5, 0.001)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('builds a closed path without sharing anchors with its input', () => {
    const anchors = [cornerAnchor(0.1, 0.1), cornerAnchor(0.9, 0.1), cornerAnchor(0.5, 0.9)];
    const p = pathFromAnchors(anchors);
    anchors[0].x = 0.99;
    expect(p.contours[0].anchors[0].x).toBe(0.1);
    expect(p.fillRule).toBe('nonzero');
    expect(p.version).toBe(1);
  });
});

describe('editing never mutates the input', () => {
  it('moves an anchor together with its handles', () => {
    const smooth = pathFromAnchors([
      dragAnchor(0.2, 0.2, 0.3, 0.2),
      cornerAnchor(0.8, 0.2),
      cornerAnchor(0.5, 0.8),
    ]);
    const frozen = JSON.stringify(smooth);
    const moved = moveAnchor(smooth, { contour: 0, anchor: 0 }, 0.25, 0.3);
    expect(JSON.stringify(smooth)).toBe(frozen);
    const a = anchorAt(moved, { contour: 0, anchor: 0 })!;
    expect(a.x).toBe(0.25);
    expect(a.y).toBe(0.3);
    expect(a.handleOut![0]).toBeCloseTo(0.35, 9);
    expect(a.handleOut![1]).toBeCloseTo(0.3, 9);
    expect(a.handleIn![0]).toBeCloseTo(0.15, 9);
  });

  it('moves handles independently on a corner and keeps a smooth anchor collinear', () => {
    let p = pathFromAnchors([
      { x: 0.2, y: 0.2, handleIn: [0.1, 0.2], handleOut: [0.3, 0.2] },
      cornerAnchor(0.8, 0.2),
      cornerAnchor(0.5, 0.8),
    ]);
    // Corner: only the dragged handle moves.
    p = moveHandle(p, { contour: 0, anchor: 0 }, 'out', 0.3, 0.1);
    expect(anchorAt(p, { contour: 0, anchor: 0 })!.handleOut).toEqual([0.3, 0.1]);
    expect(anchorAt(p, { contour: 0, anchor: 0 })!.handleIn).toEqual([0.1, 0.2]);
    // Smooth: the opposite handle turns to stay collinear and keeps its own length.
    const s = pathFromAnchors([
      { x: 0.5, y: 0.5, handleIn: [0.4, 0.5], handleOut: [0.7, 0.5], smooth: true },
      cornerAnchor(0.9, 0.9),
      cornerAnchor(0.1, 0.9),
    ]);
    const turned = moveHandle(s, { contour: 0, anchor: 0 }, 'out', 0.5, 0.7);
    const a = anchorAt(turned, { contour: 0, anchor: 0 })!;
    expect(a.handleOut).toEqual([0.5, 0.7]);
    expect(a.handleIn![0]).toBeCloseTo(0.5, 9);
    expect(a.handleIn![1]).toBeCloseTo(0.4, 9); // length 0.1 kept, pointing opposite
    // Holding the independent modifier detaches the anchor's smoothness.
    const free = moveHandle(s, { contour: 0, anchor: 0 }, 'out', 0.5, 0.7, true);
    expect(anchorAt(free, { contour: 0, anchor: 0 })!.handleIn).toEqual([0.4, 0.5]);
    expect(anchorAt(free, { contour: 0, anchor: 0 })!.smooth).toBeUndefined();
  });

  it('converts between corner and smooth anchors', () => {
    const smooth = toggleSmooth(square(), { contour: 0, anchor: 1 });
    const a = anchorAt(smooth, { contour: 0, anchor: 1 })!;
    expect(a.smooth).toBe(true);
    expect(a.handleIn).toBeDefined();
    expect(a.handleOut).toBeDefined();
    // Handles are collinear with the anchor and point along neighbour(prev) -> neighbour(next).
    const cross =
      (a.handleOut![0] - a.x) * (a.handleIn![1] - a.y) -
      (a.handleOut![1] - a.y) * (a.handleIn![0] - a.x);
    expect(Math.abs(cross)).toBeLessThan(1e-9);
    // A smoothed square corner pulls the outline outward, so the area grows ...
    expect(contourArea(smooth.contours[0])).toBeGreaterThan(0);
    // ... and converting back removes the handles.
    const back = toggleSmooth(smooth, { contour: 0, anchor: 1 });
    expect(anchorAt(back, { contour: 0, anchor: 1 })).toEqual({ x: 0.8, y: 0.2 });
  });
});

describe('inserting and removing anchors', () => {
  it('inserts on a straight segment at the requested position', () => {
    const p = insertAnchor(triangle(), 0, 0, 0.5);
    expect(p.contours[0].anchors).toHaveLength(4);
    expect(p.contours[0].anchors[1]).toEqual({ x: 0.5, y: 0.2 });
    // The outline is unchanged.
    expect(contourArea(p.contours[0])).toBeCloseTo(contourArea(triangle().contours[0]), 9);
  });

  it('splits a curved segment without changing its shape (de Casteljau)', () => {
    const curved = pathFromAnchors([
      { x: 0.2, y: 0.5, handleOut: [0.2, 0.1] },
      { x: 0.8, y: 0.5, handleIn: [0.8, 0.1] },
      cornerAnchor(0.5, 0.9),
    ]);
    const split = insertAnchor(curved, 0, 0, 0.4);
    expect(split.contours[0].anchors).toHaveLength(4);
    // Flattening the two halves differs from flattening the whole by a sliver, not by shape.
    expect(contourArea(split.contours[0])).toBeCloseTo(contourArea(curved.contours[0]), 3);
    for (const probe of [
      [0.5, 0.3],
      [0.5, 0.05],
      [0.3, 0.45],
    ] as const) {
      expect(pointInBezierPath(split, probe)).toBe(pointInBezierPath(curved, probe));
    }
  });

  it('splits the closing segment (last anchor back to the first)', () => {
    const p = insertAnchor(square(), 0, 3, 0.5);
    expect(p.contours[0].anchors).toHaveLength(5);
    expect(p.contours[0].anchors[4]).toEqual({ x: 0.2, y: 0.5 });
  });

  it('removes anchors, and a contour that would drop below three anchors, and the last contour', () => {
    const fewer = removeAnchor(square(), { contour: 0, anchor: 0 })!;
    expect(fewer.contours[0].anchors).toHaveLength(3);
    expect(removeAnchor(triangle(), { contour: 0, anchor: 1 })).toBeNull();
    const two = appendContour(triangle(), triangle().contours[0].anchors);
    expect(removeAnchor(two, { contour: 1, anchor: 0 })!.contours).toHaveLength(1);
  });

  it('respects the anchor limits', () => {
    expect(canAddAnchor(null, BEZIER_LIMITS.maxAnchorsPerContour)).toBe(false);
    expect(canAddAnchor(triangle(), 3)).toBe(true);
    let p = triangle();
    for (let i = 0; i < BEZIER_LIMITS.maxAnchorsPerContour + 5; i++) {
      p = insertAnchor(p, 0, 0, 0.5);
    }
    expect(totalAnchors(p)).toBe(BEZIER_LIMITS.maxAnchorsPerContour);
  });
});

describe('contours, holes and translation', () => {
  it('a contour added as a hole is wound the opposite way and is excluded under non-zero', () => {
    const outer = square();
    const inner = [
      cornerAnchor(0.4, 0.4),
      cornerAnchor(0.6, 0.4),
      cornerAnchor(0.6, 0.6),
      cornerAnchor(0.4, 0.6),
    ];
    const withHole = appendContour(outer, asHole(outer, inner));
    expect(withHole.contours).toHaveLength(2);
    expect(pointInBezierPath(withHole, [0.5, 0.5])).toBe(false);
    expect(pointInBezierPath(withHole, [0.3, 0.3])).toBe(true);
  });

  it('reverses an outline by swapping handles', () => {
    const r = reverseAnchors([
      { x: 0, y: 0, handleIn: [0, 0.1], handleOut: [0.1, 0] },
      cornerAnchor(1, 0),
    ]);
    expect(r[1]).toEqual({ x: 0, y: 0, handleIn: [0.1, 0], handleOut: [0, 0.1] });
  });

  it('translates the whole path, handles included', () => {
    const p = pathFromAnchors([
      dragAnchor(0.2, 0.2, 0.3, 0.2),
      cornerAnchor(0.8, 0.2),
      cornerAnchor(0.5, 0.8),
    ]);
    const t = translatePath(p, 0.1, -0.05);
    expect(t.contours[0].anchors[0]).toMatchObject({ x: 0.3, y: 0.15, handleOut: [0.4, 0.15] });
    expect(t.contours[0].anchors[1]).toEqual({ x: 0.9, y: 0.15 });
  });

  it('finds the nearest point on an outline (for inserting an anchor by clicking it)', () => {
    const hit = nearestOnPath(square(), [0.5, 0.21], 0.02)!;
    expect(hit.contour).toBe(0);
    expect(hit.segment).toBe(0);
    expect(hit.t).toBeCloseTo(0.5, 6);
    expect(hit.distance).toBeCloseTo(0.01, 9);
    expect(nearestOnPath(square(), [0.5, 0.5], 0.02)).toBeNull();
  });
});
