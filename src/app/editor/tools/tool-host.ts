import type { EditorStore } from '../services/editor-store.service';
import type { Pt } from '../util/box-math';

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** What the stage lends to an interactive tool: the store, the photo size and the view transform. */
export interface ToolHost {
  readonly store: EditorStore;
  /** Size of the mockup photograph in its own pixels, or null before it has loaded. */
  content(): { w: number; h: number } | null;
  transform(): ViewTransform;
}

export function toScreen(p: Pt, t: ViewTransform): Pt {
  return { x: p.x * t.scale + t.tx, y: p.y * t.scale + t.ty };
}

/** Screen pixels the pointer must be within to grab an anchor, handle or control point. */
export const HIT_RADIUS = 9;

/** What a pointer tool reports back to the stage. */
export interface PointerResult {
  /** The tool took the press; the stage should capture the pointer. */
  handled: boolean;
}
