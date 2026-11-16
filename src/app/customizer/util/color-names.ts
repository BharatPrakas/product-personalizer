/**
 * Plain-language names for configured swatch colours. Configurations only carry CSS colour values
 * (`#112233`), which a screen reader would read out character by character; a name such as
 * "Dark blue" is what a shopper can understand. The names are approximate by design (hue and
 * lightness buckets), so swatches that would share a name are told apart with their value.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` / `#rrggbb` (alpha ignored) to 0..255 channels; anything else is `null`. */
export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const full =
    hex.length <= 4
      ? hex
          .slice(0, 3)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

const HUES: readonly [number, string][] = [
  [15, 'red'],
  [40, 'orange'],
  [66, 'yellow'],
  [160, 'green'],
  [195, 'teal'],
  [250, 'blue'],
  [290, 'purple'],
  [345, 'pink'],
  [360, 'red'],
];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A short English name for a colour value ("Dark blue", "White"); unparseable values are returned as given. */
export function describeColor(value: string): string {
  const rgb = parseHex(value);
  if (!rgb) return value.trim();
  const { h, s, l } = toHsl(rgb);
  if (l < 0.1) return 'Black';
  if (l > 0.95) return 'White';
  if (s < 0.12) return l < 0.35 ? 'Dark grey' : l < 0.72 ? 'Grey' : 'Light grey';
  let hue = HUES.find(([limit]) => h < limit)?.[1] ?? 'red';
  if (hue === 'orange' && l < 0.4) return 'Brown';
  if (hue === 'blue' && l < 0.25) return 'Navy';
  if (hue === 'yellow' && l < 0.35) hue = 'olive';
  const shade = l < 0.3 ? 'dark ' : l > 0.75 ? 'light ' : '';
  return capitalize(shade + hue);
}

/** Relative luminance (WCAG) of a parseable colour, else `null`. */
export function luminance(value: string): number | null {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Colour for a mark drawn on top of `value` (a check on a swatch): dark on light colours, white otherwise. */
export function inkFor(value: string): string {
  const lum = luminance(value);
  return lum !== null && lum > 0.4 ? '#111827' : '#ffffff';
}

export interface SwatchView {
  value: string;
  /** Visible / accessible name, unique within the list. */
  name: string;
  ink: string;
}

/** Names for a field's colours; colours that would share a name also carry their value. */
export function swatchViews(colors: readonly string[]): SwatchView[] {
  const names = colors.map(describeColor);
  return colors.map((value, i) => {
    const shared = names.filter((n) => n === names[i]).length > 1;
    const name = shared && names[i] !== value.trim() ? `${names[i]} (${value.trim()})` : names[i];
    return { value, name, ink: inkFor(value) };
  });
}
