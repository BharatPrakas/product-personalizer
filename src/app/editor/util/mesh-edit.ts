import type { AreaPlacement, MeshSpec } from '../../customizer/models/product.models';
import { MESH_LIMITS } from '../../customizer/models/product.models';
import { meshFolds, moveMeshPoint, placementFrame } from '../../customizer/util/surface';

/** Pixel aspect (width / height) of a placement's frame, as the cylinder and fold maths need it. */
export function frameAspect(
  placement: AreaPlacement,
  mockup: { w: number; h: number },
  canvasAspect: number,
): number {
  return placementFrame(placement, mockup.w, mockup.h, canvasAspect)?.aspect ?? 1;
}

/**
 * Move control point `index` to frame-local `(x, y)` (clamped to the allowed range). Returns the new
 * mesh, or `null` when the move would fold the surface over itself or collapse a cell, so a stored
 * mesh is always valid and an invalid drag is simply refused.
 */
export function moveChecked(
  mesh: MeshSpec,
  index: number,
  x: number,
  y: number,
  aspect: number,
): MeshSpec | null {
  const lo = MESH_LIMITS.minCoordinate;
  const hi = MESH_LIMITS.maxCoordinate;
  const next = moveMeshPoint(mesh, index, [
    Math.min(hi, Math.max(lo, x)),
    Math.min(hi, Math.max(lo, y)),
  ]);
  return meshFolds(next, aspect).length === 0 ? next : null;
}
