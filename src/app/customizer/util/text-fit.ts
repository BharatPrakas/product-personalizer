/**
 * Deterministic text fitting. The ink box of the text (as reported by `measureText`) must fit
 * inside the layer box; the size is the largest integer between `maxSize` and `minSize` that fits.
 */

/** Ink extents around the alignment point and baseline, in pixels, as from `TextMetrics`. */
export interface InkBox {
  /** `actualBoundingBoxLeft`: distance from the alignment point to the left edge of the ink. */
  left: number;
  /** `actualBoundingBoxRight`. */
  right: number;
  /** `actualBoundingBoxAscent`. */
  ascent: number;
  /** `actualBoundingBoxDescent`. */
  descent: number;
}

export interface FitResult {
  fontSize: number;
  fits: boolean;
  ink: InkBox;
}

export function inkWidth(ink: InkBox): number {
  return ink.left + ink.right;
}

export function inkHeight(ink: InkBox): number {
  return ink.ascent + ink.descent;
}

function fitsBox(ink: InkBox, width: number, height: number): boolean {
  // Sub-pixel slack so a result of exactly the box size isn't rejected by float noise.
  return inkWidth(ink) <= width + 0.01 && inkHeight(ink) <= height + 0.01;
}

export function fitText(
  measure: (fontSize: number) => InkBox,
  box: { width: number; height: number },
  maxSize: number,
  minSize: number,
): FitResult {
  const maxInk = measure(maxSize);
  if (fitsBox(maxInk, box.width, box.height)) return { fontSize: maxSize, fits: true, ink: maxInk };

  // The configured minimum is always the floor, even when it is fractional.
  const minInk = measure(minSize);
  if (!fitsBox(minInk, box.width, box.height))
    return { fontSize: minSize, fits: false, ink: minInk };

  // Invariant: `minSize` fits. Find the largest whole-pixel size in [minSize, maxSize] that fits.
  let best: FitResult = { fontSize: minSize, fits: true, ink: minInk };
  let low = Math.ceil(minSize);
  let high = Math.floor(maxSize);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const ink = measure(mid);
    if (fitsBox(ink, box.width, box.height)) {
      best = { fontSize: mid, fits: true, ink };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Draw position for text aligned inside a box, using ink bounds. `ink` must have been measured
 * with the same `textAlign` that will be used to draw.
 */
export function placeText(
  ink: InkBox,
  box: { x: number; y: number; width: number; height: number },
  align: 'left' | 'center' | 'right',
): { x: number; y: number } {
  let x: number;
  switch (align) {
    case 'left':
      x = box.x + ink.left;
      break;
    case 'right':
      x = box.x + box.width - ink.right;
      break;
    default:
      x = box.x + box.width / 2 - (ink.right - ink.left) / 2;
  }
  const y = box.y + box.height / 2 + (ink.ascent - ink.descent) / 2;
  return { x, y };
}
