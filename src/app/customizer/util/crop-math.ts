/**
 * Crop geometry. A crop is `[left, top, width, height]`, normalised 0..1 relative to the canonical
 * (EXIF-oriented) image, and always has the aspect ratio of the destination layer, so images are
 * never stretched. Zoom 1 is the largest crop that fits; larger zoom values shrink the crop.
 */

import type { CropRect } from '../models/draft.models';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Relative tolerance when comparing aspect ratios (JSON round trips and rounding). */
export const ASPECT_TOLERANCE = 0.005;

const EPSILON = 1e-9;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Normalised size of the zoom=1 crop for an image and target aspect (width / height). */
function baseSize(imgW: number, imgH: number, aspect: number): { w: number; h: number } {
  const imgAspect = imgW / imgH;
  return imgAspect >= aspect ? { w: aspect / imgAspect, h: 1 } : { w: 1, h: imgAspect / aspect };
}

/** Largest centred crop with the requested aspect ratio. */
export function defaultCrop(imgW: number, imgH: number, aspect: number): CropRect {
  const { w, h } = baseSize(imgW, imgH, aspect);
  return [(1 - w) / 2, (1 - h) / 2, w, h];
}

/** Zoom factor of a crop (1 = whole fit, larger = tighter). */
export function zoomOf(crop: CropRect, imgW: number, imgH: number, aspect: number): number {
  return baseSize(imgW, imgH, aspect).w / crop[2];
}

/** Change zoom around the crop centre; the result is clamped inside the image. */
export function zoomCrop(
  crop: CropRect,
  zoom: number,
  imgW: number,
  imgH: number,
  aspect: number,
): CropRect {
  const base = baseSize(imgW, imgH, aspect);
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const w = base.w / z;
  const h = base.h / z;
  const cx = crop[0] + crop[2] / 2;
  const cy = crop[1] + crop[3] / 2;
  return clampCrop([cx - w / 2, cy - h / 2, w, h]);
}

/** Move the crop window; deltas are fractions of the current crop size. */
export function panCrop(crop: CropRect, dxFraction: number, dyFraction: number): CropRect {
  return clampCrop([
    crop[0] + dxFraction * crop[2],
    crop[1] + dyFraction * crop[3],
    crop[2],
    crop[3],
  ]);
}

/** Keep a crop inside the unit square without changing its size. */
export function clampCrop(crop: CropRect): CropRect {
  const [, , w, h] = crop;
  return [clamp(crop[0], 0, 1 - w), clamp(crop[1], 0, 1 - h), w, h];
}

export interface CropCheck {
  ok: boolean;
  reason?: string;
}

/** Validate shape, bounds and aspect ratio (against the destination layer) of a crop. */
export function checkCrop(
  crop: unknown,
  imgW: number | null,
  imgH: number | null,
  aspect: number,
): CropCheck {
  if (
    !Array.isArray(crop) ||
    crop.length !== 4 ||
    !crop.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return { ok: false, reason: 'crop must be [left, top, width, height]' };
  }
  const [left, top, width, height] = crop as number[];
  if (width <= 0 || height <= 0) return { ok: false, reason: 'crop size must be positive' };
  if (
    left < -EPSILON ||
    top < -EPSILON ||
    left + width > 1 + EPSILON ||
    top + height > 1 + EPSILON
  ) {
    return { ok: false, reason: 'crop must lie inside the image' };
  }
  if (imgW !== null && imgH !== null) {
    const cropAspect = (width * imgW) / (height * imgH);
    if (Math.abs(cropAspect - aspect) / aspect > ASPECT_TOLERANCE) {
      return { ok: false, reason: 'crop aspect ratio does not match the photo area' };
    }
  }
  return { ok: true };
}

/** Source rectangle in image pixels for `drawImage`. */
export function cropToPixels(crop: CropRect, imgW: number, imgH: number) {
  return { sx: crop[0] * imgW, sy: crop[1] * imgH, sw: crop[2] * imgW, sh: crop[3] * imgH };
}

export interface Resolution {
  dpiX: number;
  dpiY: number;
  /** The lower of the two axes. */
  effective: number;
}

/**
 * Effective DPI = retained source crop pixels / physical size of the image layer, per axis.
 * `layerFraction*` are layer width / canvas width and layer height / canvas height.
 */
export function effectiveDpi(
  crop: CropRect,
  imgW: number,
  imgH: number,
  layerFractionX: number,
  layerFractionY: number,
  printWidthMm: number,
  printHeightMm: number,
): Resolution {
  const inchesX = (layerFractionX * printWidthMm) / 25.4;
  const inchesY = (layerFractionY * printHeightMm) / 25.4;
  const dpiX = (crop[2] * imgW) / inchesX;
  const dpiY = (crop[3] * imgH) / inchesY;
  return { dpiX, dpiY, effective: Math.min(dpiX, dpiY) };
}
