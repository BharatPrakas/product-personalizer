/** Rotated-rectangle math for the stage: hit testing, handles, move / resize / rotate. */

export interface Pt {
  x: number;
  y: number;
}

/** A box described by its centre, size and clockwise rotation in degrees. */
export interface RBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export const RESIZE_HANDLES: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const RAD = Math.PI / 180;

export function rotatePoint(p: Pt, c: Pt, deg: number): Pt {
  const cos = Math.cos(deg * RAD);
  const sin = Math.sin(deg * RAD);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Corners in order top-left, top-right, bottom-right, bottom-left. */
export function corners(b: RBox): [Pt, Pt, Pt, Pt] {
  const c = { x: b.cx, y: b.cy };
  const hw = b.w / 2;
  const hh = b.h / 2;
  return [
    rotatePoint({ x: b.cx - hw, y: b.cy - hh }, c, b.rot),
    rotatePoint({ x: b.cx + hw, y: b.cy - hh }, c, b.rot),
    rotatePoint({ x: b.cx + hw, y: b.cy + hh }, c, b.rot),
    rotatePoint({ x: b.cx - hw, y: b.cy + hh }, c, b.rot),
  ];
}

export function containsPoint(b: RBox, p: Pt): boolean {
  const local = rotatePoint(p, { x: b.cx, y: b.cy }, -b.rot);
  return Math.abs(local.x - b.cx) <= b.w / 2 && Math.abs(local.y - b.cy) <= b.h / 2;
}

const HANDLE_SIGNS: Record<Exclude<HandleId, 'rotate'>, readonly [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

/** Handle positions in content space; the rotate handle floats `rotateGap` above the top edge. */
export function handlePoints(b: RBox, rotateGap: number): Record<HandleId, Pt> {
  const c = { x: b.cx, y: b.cy };
  const out = {} as Record<HandleId, Pt>;
  for (const id of RESIZE_HANDLES) {
    const [sx, sy] = HANDLE_SIGNS[id as Exclude<HandleId, 'rotate'>];
    out[id] = rotatePoint({ x: b.cx + (sx * b.w) / 2, y: b.cy + (sy * b.h) / 2 }, c, b.rot);
  }
  out.rotate = rotatePoint({ x: b.cx, y: b.cy - b.h / 2 - rotateGap }, c, b.rot);
  return out;
}

export interface ResizeOptions {
  /** Keep the starting aspect ratio. */
  lockAspect: boolean;
  /** Resize symmetrically about the centre (Alt). */
  fromCenter: boolean;
  /** Smallest allowed width / height. */
  min: number;
}

export function resizeBox(
  start: RBox,
  handle: Exclude<HandleId, 'rotate'>,
  pointer: Pt,
  opts: ResizeOptions,
): RBox {
  const [sx, sy] = HANDLE_SIGNS[handle];
  const local = rotatePoint(pointer, { x: start.cx, y: start.cy }, -start.rot);
  const lx = local.x - start.cx;
  const ly = local.y - start.cy;
  let left = -start.w / 2;
  let right = start.w / 2;
  let top = -start.h / 2;
  let bottom = start.h / 2;
  if (sx > 0) right = lx;
  if (sx < 0) left = lx;
  if (sy > 0) bottom = ly;
  if (sy < 0) top = ly;
  if (opts.fromCenter) {
    if (sx !== 0) {
      const half = Math.abs(sx > 0 ? right : left);
      left = -half;
      right = half;
    }
    if (sy !== 0) {
      const half = Math.abs(sy > 0 ? bottom : top);
      top = -half;
      bottom = half;
    }
  }
  let w = Math.max(opts.min, right - left);
  let h = Math.max(opts.min, bottom - top);
  if (opts.lockAspect && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    if (sx !== 0 && sy !== 0) {
      const scale = Math.max(w / start.w, h / start.h);
      w = start.w * scale;
      h = start.h * scale;
    } else if (sx !== 0) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
  }
  // Re-anchor: the edge opposite the dragged handle stays put (unless resizing from the centre).
  const anchorX =
    opts.fromCenter || sx === 0 ? (left + right) / 2 : sx > 0 ? -start.w / 2 : start.w / 2;
  const anchorY =
    opts.fromCenter || sy === 0 ? (top + bottom) / 2 : sy > 0 ? -start.h / 2 : start.h / 2;
  const centerX = opts.fromCenter || sx === 0 ? anchorX : anchorX + (sx > 0 ? w / 2 : -w / 2);
  const centerY = opts.fromCenter || sy === 0 ? anchorY : anchorY + (sy > 0 ? h / 2 : -h / 2);
  const world = rotatePoint(
    { x: start.cx + centerX, y: start.cy + centerY },
    { x: start.cx, y: start.cy },
    start.rot,
  );
  return { cx: world.x, cy: world.y, w, h, rot: start.rot };
}

export function rotateBox(start: RBox, pointer: Pt, snap: boolean): RBox {
  let deg = (Math.atan2(pointer.y - start.cy, pointer.x - start.cx) / RAD + 90) % 360;
  if (deg > 180) deg -= 360;
  if (deg < -180) deg += 360;
  if (snap) deg = Math.round(deg / 15) * 15;
  return { ...start, rot: Math.round(deg * 10) / 10 };
}

export function moveBox(start: RBox, dx: number, dy: number): RBox {
  return { ...start, cx: start.cx + dx, cy: start.cy + dy };
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const round = (value: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
