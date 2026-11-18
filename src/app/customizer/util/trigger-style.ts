import type { ZbTriggerStyle } from '../models/trigger-style';

/**
 * Turns the host's `triggerStyle` into CSS custom properties for the trigger button.
 *
 * The value comes from outside (a Builder, a theme, a page), so nothing in it is trusted: each field is
 * checked against a narrow grammar (a colour, a bounded number, a keyword, a font name) and anything else
 * is dropped, so the default applies. The result is a map of custom properties that the component sets
 * one by one through the CSSOM (`style.setProperty`), never CSS text, so a value cannot add a rule, an
 * `url()` or a second declaration, and a strict `style-src` CSP is not affected.
 */

export const DEFAULT_TRIGGER_LABEL = 'Personalize';
export const SAVED_TRIGGER_LABEL = 'Edit personalization';
const MAX_JSON_CHARS = 4_000;
const MAX_LABEL_CHARS = 60;

export interface TriggerAppearance {
  /** Label from the host, or null for the element's own (which changes once a design is saved). */
  label: string | null;
  align: 'start' | 'center' | 'end';
  /** Custom properties (`--zbt-*`) to set on the button. */
  vars: Readonly<Record<string, string>>;
}

/** Resolves any CSS colour (including names) to RGBA; used for the contrast check. */
export type ColorResolver = (value: string) => Rgba | null;
export type Rgba = readonly [number, number, number, number];

/** `triggerStyle` arrives as an object (property) or JSON (attribute); anything else is no style. */
export function coerceTriggerStyle(value: unknown): ZbTriggerStyle | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text.length > MAX_JSON_CHARS) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ZbTriggerStyle) : null;
}

// ---- colours -------------------------------------------------------------------------------------

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-z.%+\-\s,/]+\)$/i;
const NAMED_COLOR = /^[a-z]{3,30}$/i;
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
/** Used when the browser cannot validate names (no `CSS.supports`): the names a Builder palette offers. */
const KNOWN_NAMES = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'brown',
  'navy', 'teal', 'maroon', 'olive', 'silver', 'gold', 'crimson', 'transparent', 'currentcolor',
]);

function supportsColor(value: string): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' ? CSS.supports('color', value) : true;
}

/** A colour this grammar knows, or null. `inherit`, `var()`, `url()` and every other function are refused. */
export function parseColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > 64) return null;
  if (HEX.test(text)) return text;
  if (FUNCTION_COLOR.test(text)) return supportsColor(text) ? text : null;
  if (NAMED_COLOR.test(text)) {
    const lower = text.toLowerCase();
    if (CSS_WIDE.has(lower)) return null;
    const hasValidator = typeof CSS !== 'undefined' && typeof CSS.supports === 'function';
    return (hasValidator ? supportsColor(lower) : KNOWN_NAMES.has(lower)) ? lower : null;
  }
  return null;
}

/** Hex, rgb(a) and hsl(a) without a browser; names go through the optional resolver. */
export function toRgba(color: string, resolver?: ColorResolver): Rgba | null {
  const text = color.trim().toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(text);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    const num = (v: string | undefined, scale = 1) =>
      v === undefined ? NaN : v.endsWith('%') ? (parseFloat(v) / 100) * scale : parseFloat(v);
    const alpha = parts[3] === undefined ? 1 : Math.min(1, Math.max(0, num(parts[3], 1)));
    if (fn[1].startsWith('rgb')) {
      const rgb = [0, 1, 2].map((i) => Math.min(255, Math.max(0, num(parts[i], 255))));
      return rgb.some(Number.isNaN) ? null : [rgb[0], rgb[1], rgb[2], alpha];
    }
    const h = (((parseFloat(parts[0] ?? '') % 360) + 360) % 360) / 360;
    const s = num(parts[1], 1);
    const l = num(parts[2], 1);
    if ([h, s, l].some(Number.isNaN)) return null;
    const hue = (t: number) => {
      const x = (t + 1) % 1;
      if (x < 1 / 6) return 6 * x;
      if (x < 1 / 2) return 1;
      if (x < 2 / 3) return 4 - 6 * x;
      return 0;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number) => Math.round(255 * (p + (q - p) * hue(t)));
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3), alpha];
  }
  return resolver?.(text) ?? null;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA_TEXT = 4.5;
const DARK_TEXT = '#111827';
const LIGHT_TEXT = '#ffffff';

/**
 * Keeps text readable on its background: the host's text colour stays when it reaches 4.5:1, otherwise
 * black or white (whichever contrasts more) takes over. Only for opaque, known pairs.
 */
function readableOn(text: string, background: string, resolver?: ColorResolver): string {
  const bg = toRgba(background, resolver);
  const fg = toRgba(text, resolver);
  if (!bg || !fg || bg[3] < 1 || fg[3] < 1) return text;
  if (contrastRatio(fg, bg) >= AA_TEXT) return text;
  const dark = toRgba(DARK_TEXT)!;
  const light = toRgba(LIGHT_TEXT)!;
  return contrastRatio(dark, bg) >= contrastRatio(light, bg) ? DARK_TEXT : LIGHT_TEXT;
}

// ---- numbers, keywords, fonts ----------------------------------------------------------------------

function bounded(value: unknown, min: number, max: number): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value.trim())
        ? parseFloat(value)
        : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function codes(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const upper = value.map((v) => (typeof v === 'string' ? v.trim().toUpperCase() : ''));
  return allowed.filter((c) => upper.includes(c));
}

const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}$/;
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

/** `Roboto, "Open Sans", sans-serif` -> a family list built only from validated names. */
function parseFontFamily(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  const families: string[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (!name) continue;
    if (GENERIC_FAMILIES.has(name.toLowerCase())) families.push(name.toLowerCase());
    else if (FONT_NAME.test(name)) families.push(`"${name}"`);
    else return null;
  }
  return families.length > 0 && families.length <= 6 ? families.join(', ') : null;
}

const ALIGN: Record<string, TriggerAppearance['align']> = {
  start: 'start', left: 'start', center: 'center', end: 'end', right: 'end',
};

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_LABEL_CHARS) : null;
}

// ---- the mapping ---------------------------------------------------------------------------------------

export function resolveTriggerStyle(raw: unknown, resolver?: ColorResolver): TriggerAppearance {
  const style = (coerceTriggerStyle(raw) ?? {}) as Record<string, unknown>;
  const vars: Record<string, string> = {};
  const set = (name: string, value: string | number | null, unit = '') => {
    if (value !== null) vars[`--zbt-${name}`] = `${value}${unit}`;
  };

  const background = parseColor(style['buttonColor']);
  let color = parseColor(style['buttonTextColor']);
  if (background && !color) color = LIGHT_TEXT; // the default text colour must be checked against the new background too
  if (background && color) color = readableOn(color, background, resolver);
  set('bg', background);
  set('color', color);

  const font = parseFontFamily(style['buttonFont']);
  set('font', font ? `${font}, system-ui, sans-serif` : null);
  set('size', bounded(style['buttonTextSize'], 8, 72), 'px');
  const fontStyle = codes(style['buttonTextFontStyle'], ['B', 'I', 'U']);
  if (fontStyle.length > 0) {
    set('weight', fontStyle.includes('B') ? 700 : 400);
    set('fstyle', fontStyle.includes('I') ? 'italic' : 'normal');
    set('decoration', fontStyle.includes('U') ? 'underline' : 'none');
  }

  const radius = bounded(style['buttonRadius'], 0, 100);
  if (radius !== null) {
    const corners = codes(style['borderRadiusPositions'], ['TL', 'TR', 'BR', 'BL']);
    const on = (c: string) => (corners.length === 0 || corners.includes(c) ? radius : 0);
    set('radius', `${on('TL')}px ${on('TR')}px ${on('BR')}px ${on('BL')}px`);
  }

  const padBlock = bounded(style['buttonPadding'], 0, 64);
  set('pad-block', padBlock, 'px');
  const padInline = bounded(style['buttonPaddingInline'], 0, 96);
  set('pad-inline', padInline ?? (padBlock !== null ? padBlock * 2 : null), 'px');

  const width = style['width'];
  if (width === 'full') set('width', '100%');
  else set('width', bounded(width, 40, 1200), 'px');

  const thickness = bounded(style['buttonBorderThickness'], 0, 12);
  if (thickness !== null) {
    const sides = codes(style['buttonBorderPositions'], ['T', 'R', 'B', 'L']);
    const on = (s: string) => (sides.length === 0 || sides.includes(s) ? thickness : 0);
    set('bw', `${on('T')}px ${on('R')}px ${on('B')}px ${on('L')}px`);
    const borderStyle = typeof style['borderStyle'] === 'string' ? style['borderStyle'].trim().toLowerCase() : '';
    set('bs', ['solid', 'dashed', 'dotted', 'double'].includes(borderStyle) ? borderStyle : 'solid');
  }
  set('bc', parseColor(style['buttonBorderColor']));

  if (style['isButtonHoverEffect'] !== false) {
    const hoverBg = parseColor(style['buttonHoverColor']);
    let hoverColor = parseColor(style['buttonHoverTextColor']);
    const effectiveBg = hoverBg ?? background;
    if (hoverBg && !hoverColor) hoverColor = color ?? LIGHT_TEXT;
    if (effectiveBg && hoverColor) hoverColor = readableOn(hoverColor, effectiveBg, resolver);
    set('hover-bg', hoverBg);
    set('hover-color', hoverColor);
    set('hover-bc', parseColor(style['buttonBorderHoverColor']));
  }

  const disabledBg = parseColor(style['buttonDisabledColor']);
  const disabledColor = parseColor(style['buttonDisabledTextColor']);
  const disabledBorder = parseColor(style['buttonDisabledBorderColor']);
  set('dis-bg', disabledBg);
  set('dis-color', disabledColor);
  set('dis-bc', disabledBorder);
  // A merchant who styled the disabled state does not also want the default fade on top of it.
  if (disabledBg || disabledColor || disabledBorder) set('dis-opacity', 1);

  const align = typeof style['buttonAlignment'] === 'string' ? ALIGN[style['buttonAlignment'].trim().toLowerCase()] : undefined;
  return { label: cleanLabel(style['buttonText']), align: align ?? 'start', vars };
}

/** Browser-only colour resolver for names (`rebeccapurple`): paints one pixel and reads it back. */
export function canvasColorResolver(): ColorResolver {
  let context: CanvasRenderingContext2D | null | undefined;
  return (value) => {
    try {
      if (context === undefined) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        context = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (!context) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    } catch {
      return null;
    }
  };
}
