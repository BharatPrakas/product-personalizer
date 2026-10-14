import { InkBox, fitText, inkHeight, inkWidth, placeText } from './text-fit';

/** A fake font: every character is 0.6em wide, ascent 0.75em, descent 0.2em, centred advance. */
const fakeMeasure =
  (text: string, align: 'left' | 'center' | 'right' = 'center') =>
  (size: number): InkBox => {
    const width = text.length * 0.6 * size;
    if (align === 'left')
      return { left: 0, right: width, ascent: 0.75 * size, descent: 0.2 * size };
    if (align === 'right')
      return { left: width, right: 0, ascent: 0.75 * size, descent: 0.2 * size };
    return { left: width / 2, right: width / 2, ascent: 0.75 * size, descent: 0.2 * size };
  };

describe('fitText (F03)', () => {
  const box = { width: 1000, height: 200 };

  it('keeps the configured size when the text already fits', () => {
    const result = fitText(fakeMeasure('Hi'), box, 100, 20);
    expect(result).toMatchObject({ fontSize: 100, fits: true });
  });

  it('shrinks to the largest integer size that fits', () => {
    // 20 chars * 0.6 = 12em wide -> 1000px / 12 = 83.33 -> 83
    const result = fitText(fakeMeasure('x'.repeat(20)), box, 200, 20);
    expect(result.fits).toBe(true);
    expect(result.fontSize).toBe(83);
    expect(inkWidth(result.ink)).toBeLessThanOrEqual(1000);
    const next = fakeMeasure('x'.repeat(20))(84);
    expect(inkWidth(next)).toBeGreaterThan(1000);
  });

  it('is limited by height as well as width', () => {
    const result = fitText(fakeMeasure('x'), { width: 1000, height: 95 }, 300, 10);
    expect(inkHeight(result.ink)).toBeLessThanOrEqual(95);
    expect(result.fontSize).toBe(100); // 0.95em tall
  });

  it('reports an overflow when even the minimum size does not fit (blocks Save)', () => {
    const result = fitText(fakeMeasure('x'.repeat(100)), box, 100, 36);
    expect(result.fits).toBe(false);
    expect(result.fontSize).toBe(36);
  });

  it('accepts text that fits exactly at the minimum size', () => {
    // 1000 / (0.6 * 28) = 59.5 -> 59 chars fit at 28px
    const result = fitText(fakeMeasure('x'.repeat(59)), box, 100, 28);
    expect(result.fits).toBe(true);
    expect(result.fontSize).toBe(28);
  });

  it('is deterministic', () => {
    const run = () => fitText(fakeMeasure('Alexandria'), box, 120, 24);
    expect(run()).toEqual(run());
  });
});

describe('fitText with fractional font sizes', () => {
  const box = { width: 1000, height: 200 };

  it('uses the exact configured minimum when it fits, even if no whole size above it does', () => {
    // 20 chars * 0.6 = 12em: fits at 83.3px. With min 20.5 / max 48 nothing is shrunk below 48 needed...
    const narrow = { width: 12 * 20.5 + 1, height: 200 }; // fits at 20.5 (246 px) but not at 21 (252 px)
    const result = fitText(fakeMeasure('x'.repeat(20)), narrow, 48, 20.5);
    expect(result).toMatchObject({ fontSize: 20.5, fits: true });
  });

  it('measures the minimum itself when min and max are within one pixel', () => {
    const result = fitText(fakeMeasure('x'.repeat(100)), box, 48.5, 48.2);
    expect(result.fits).toBe(false);
    expect(result.fontSize).toBe(48.2);
    const ok = fitText(fakeMeasure('x'.repeat(30)), box, 48.5, 48.2); // 30 * 0.6 * 48.5 = 873 -> fits at max
    expect(ok).toMatchObject({ fontSize: 48.5, fits: true });
    const between = fitText(fakeMeasure('x'.repeat(34)), box, 48.5, 48.2); // 34 * 0.6 * 48.2 = 983 fits, at 48.5 = 989... fits
    expect(between.fits).toBe(true);
  });

  it('still returns whole pixel sizes above the minimum', () => {
    const result = fitText(fakeMeasure('x'.repeat(20)), box, 200.5, 20.5);
    expect(Number.isInteger(result.fontSize)).toBe(true);
    expect(result.fontSize).toBe(83);
  });
});

describe('placeText', () => {
  const layer = { x: 100, y: 200, width: 400, height: 100 };

  it('centres the ink box in the layer, horizontally and vertically', () => {
    const ink = fakeMeasure('abcd')(60); // 144 wide, ascent 45, descent 12
    const { x, y } = placeText(ink, layer, 'center');
    expect(x - ink.left).toBeCloseTo(100 + (400 - 144) / 2);
    // ink spans y-ascent .. y+descent, centred on 250
    expect((y - ink.ascent + (y + ink.descent)) / 2).toBeCloseTo(250);
  });

  it('left-aligns the ink to the layer edge', () => {
    const ink: InkBox = { left: 3, right: 140, ascent: 40, descent: 10 }; // overhangs 3px to the left of the anchor
    const { x } = placeText(ink, layer, 'left');
    expect(x - ink.left).toBe(100);
  });

  it('right-aligns the ink to the layer edge', () => {
    const ink: InkBox = { left: 140, right: 4, ascent: 40, descent: 10 };
    const { x } = placeText(ink, layer, 'right');
    expect(x + ink.right).toBe(500);
  });
});
