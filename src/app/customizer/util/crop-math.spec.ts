import { CropRect } from '../models/draft.models';
import {
  MAX_ZOOM,
  checkCrop,
  clampCrop,
  cropToPixels,
  defaultCrop,
  effectiveDpi,
  panCrop,
  zoomCrop,
  zoomOf,
} from './crop-math';

const aspectOf = (crop: CropRect, w: number, h: number) => (crop[2] * w) / (crop[3] * h);

describe('defaultCrop', () => {
  it('is the largest centred crop with the layer aspect (landscape photo, square layer)', () => {
    const crop = defaultCrop(1800, 1200, 1);
    expect(crop[0]).toBeCloseTo(1 / 6);
    expect(crop[1]).toBe(0);
    expect(crop[3]).toBe(1);
    expect(aspectOf(crop, 1800, 1200)).toBeCloseTo(1);
  });

  it('is the largest centred crop for a portrait photo', () => {
    const crop = defaultCrop(1000, 1500, 1);
    expect(crop[2]).toBe(1);
    expect(crop[1]).toBeCloseTo(1 / 6);
    expect(aspectOf(crop, 1000, 1500)).toBeCloseTo(1);
  });

  it.each([0.5, 0.75, 1, 1.5, 3])('never stretches: aspect %s is preserved', (aspect) => {
    const crop = defaultCrop(1234, 987, aspect);
    expect(aspectOf(crop, 1234, 987)).toBeCloseTo(aspect, 6);
    expect(checkCrop(crop, 1234, 987, aspect).ok).toBe(true);
  });
});

describe('zoom and pan', () => {
  const [w, h, aspect] = [1800, 1200, 1];

  it('zoom 1 equals the default crop and zoom 2 halves the window around its centre', () => {
    const base = defaultCrop(w, h, aspect);
    expect(zoomOf(base, w, h, aspect)).toBeCloseTo(1);
    const zoomed = zoomCrop(base, 2, w, h, aspect);
    expect(zoomOf(zoomed, w, h, aspect)).toBeCloseTo(2);
    expect(zoomed[0] + zoomed[2] / 2).toBeCloseTo(base[0] + base[2] / 2);
    expect(zoomed[1] + zoomed[3] / 2).toBeCloseTo(base[1] + base[3] / 2);
    expect(aspectOf(zoomed, w, h)).toBeCloseTo(1);
  });

  it('clamps zoom to [1, MAX_ZOOM]', () => {
    const base = defaultCrop(w, h, aspect);
    expect(zoomOf(zoomCrop(base, 0.2, w, h, aspect), w, h, aspect)).toBeCloseTo(1);
    expect(zoomOf(zoomCrop(base, 99, w, h, aspect), w, h, aspect)).toBeCloseTo(MAX_ZOOM);
  });

  it('keeps the window inside the image when panning past an edge', () => {
    const zoomed = zoomCrop(defaultCrop(w, h, aspect), 4, w, h, aspect);
    const panned = panCrop(zoomed, -50, -50);
    expect(panned[0]).toBe(0);
    expect(panned[1]).toBe(0);
    const other = panCrop(zoomed, 50, 50);
    expect(other[0] + other[2]).toBeCloseTo(1);
    expect(other[1] + other[3]).toBeCloseTo(1);
  });

  it('pan moves by a fraction of the visible window', () => {
    const zoomed = zoomCrop(defaultCrop(w, h, aspect), 4, w, h, aspect);
    const moved = panCrop(zoomed, 0.5, 0);
    expect(moved[0] - zoomed[0]).toBeCloseTo(zoomed[2] * 0.5);
    expect(moved[2]).toBe(zoomed[2]);
  });

  it('clampCrop never changes size', () => {
    expect(clampCrop([-0.2, 0.9, 0.3, 0.3])).toEqual([0, 0.7, 0.3, 0.3]);
  });
});

describe('checkCrop (F05)', () => {
  it.each([
    [[0, 0, 0, 1], 'positive'],
    [[0, 0, 1, -1], 'positive'],
    [[0.5, 0, 0.6, 1], 'inside'],
    [[0, 0.5, 1, 0.6], 'inside'],
    [[0, 0, 1], 'must be'],
    ['crop', 'must be'],
    [[0, 0, Number.NaN, 1], 'must be'],
  ])('rejects %j', (crop, reason) => {
    const result = checkCrop(crop, 1000, 1000, 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it('rejects a crop whose pixel aspect ratio differs from the layer', () => {
    expect(checkCrop([0, 0, 1, 0.5], 1000, 1000, 1).reason).toContain('aspect');
  });

  it('converts to source pixels for drawImage', () => {
    expect(cropToPixels([0.25, 0.5, 0.5, 0.25], 800, 400)).toEqual({
      sx: 200,
      sy: 200,
      sw: 400,
      sh: 100,
    });
  });
});

describe('effectiveDpi (F06)', () => {
  // Tote sample: 800 px of a 1200 px canvas printed 203.2 mm (8 in) wide -> a 5.333 in photo.
  it('is source crop pixels per physical inch, evaluated on both axes', () => {
    const result = effectiveDpi(
      [0, 0, 1200 / 1800, 1],
      1800,
      1200,
      800 / 1200,
      800 / 1200,
      203.2,
      203.2,
    );
    expect(result.dpiX).toBeCloseTo(225, 3);
    expect(result.dpiY).toBeCloseTo(225, 3);
    expect(result.effective).toBeCloseTo(225, 3);
  });

  it('takes the lower axis', () => {
    const result = effectiveDpi([0, 0, 1, 1], 1000, 400, 1, 1, 254, 254); // 10 in x 10 in
    expect(result.dpiX).toBeCloseTo(100);
    expect(result.dpiY).toBeCloseTo(40);
    expect(result.effective).toBeCloseTo(40);
  });

  it('halves when the same source pixels are stretched over twice the physical size', () => {
    const small = effectiveDpi([0, 0, 1, 1], 1000, 1000, 0.5, 0.5, 100, 100);
    const large = effectiveDpi([0, 0, 1, 1], 1000, 1000, 1, 1, 100, 100);
    expect(small.effective).toBeCloseTo(large.effective * 2);
  });

  it('rises as the crop zooms in only if source pixels are retained: zooming in keeps fewer pixels', () => {
    const wide = effectiveDpi([0, 0, 1, 1], 2000, 2000, 1, 1, 200, 200);
    const tight = effectiveDpi([0.25, 0.25, 0.5, 0.5], 2000, 2000, 1, 1, 200, 200);
    expect(tight.effective).toBeCloseTo(wide.effective / 2);
  });
});
