/**
 * Text layout inside a box: single-line fit (the original behaviour, ink-based) and multi-line
 * wrapping with automatic font-size fitting. Pure: measurement is injected.
 */

import type { TextAlign } from '../models/config.models';
import { InkBox, fitText, inkWidth, placeText } from './text-fit';

export interface TextStyle {
  family: string;
  bold: boolean;
  italic: boolean;
}

export interface LayoutLine {
  text: string;
  /** Anchor x for the alignment, relative to the box's left edge. */
  x: number;
  /** Alphabetic baseline, relative to the box's top edge. */
  y: number;
  /** Advance / ink width, used to draw underlines. */
  width: number;
}

export interface TextLayout {
  fontSize: number;
  fits: boolean;
  font: string;
  lines: LayoutLine[];
}

export interface TextMeasurer {
  /** Ink extents of one line for a canvas font shorthand. */
  ink: (font: string, align: TextAlign, text: string) => InkBox;
  /** Advance width of one line. */
  width: (font: string, text: string) => number;
}

export function fontShorthand(style: TextStyle, size: number): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size}px "${style.family}"`;
}

export interface LayoutRequest {
  text: string;
  box: { width: number; height: number };
  maxSize: number;
  minSize: number;
  align: TextAlign;
  wrap: boolean;
  lineHeight: number;
  verticalAlign: 'top' | 'middle' | 'bottom';
  style: TextStyle;
}

export function layoutText(request: LayoutRequest, measurer: TextMeasurer): TextLayout {
  return request.wrap ? layoutWrapped(request, measurer) : layoutSingleLine(request, measurer);
}

function layoutSingleLine(r: LayoutRequest, m: TextMeasurer): TextLayout {
  const fit = fitText(
    (size) => m.ink(fontShorthand(r.style, size), r.align, r.text),
    r.box,
    r.maxSize,
    r.minSize,
  );
  const position = placeText(fit.ink, { x: 0, y: 0, ...r.box }, r.align);
  return {
    fontSize: fit.fontSize,
    fits: fit.fits,
    font: fontShorthand(r.style, fit.fontSize),
    lines: [{ text: r.text, x: position.x, y: position.y, width: inkWidth(fit.ink) }],
  };
}

/** Greedy word wrap; words wider than the box are broken by character. */
export function wrapLines(
  text: string,
  maxWidth: number,
  width: (text: string) => number,
): string[] {
  const lines: string[] = [];
  let current = '';
  const push = () => {
    if (current) lines.push(current);
    current = '';
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    push();
    if (width(word) <= maxWidth) {
      current = word;
      continue;
    }
    for (const char of Array.from(word)) {
      if (current && width(current + char) > maxWidth) push();
      current += char;
    }
  }
  push();
  return lines;
}

function layoutWrapped(r: LayoutRequest, m: TextMeasurer): TextLayout {
  const attempt = (size: number) => {
    const font = fontShorthand(r.style, size);
    const lines = wrapLines(r.text, r.box.width, (t) => m.width(font, t));
    const lineAdvance = size * r.lineHeight;
    const height = lines.length * lineAdvance;
    const widest = Math.max(0, ...lines.map((line) => m.width(font, line)));
    return {
      size,
      font,
      lines,
      lineAdvance,
      height,
      fits: height <= r.box.height + 0.01 && widest <= r.box.width + 0.01,
    };
  };

  let best = attempt(r.maxSize);
  if (!best.fits) {
    const floor = attempt(r.minSize);
    if (!floor.fits) {
      best = floor;
    } else {
      best = floor;
      let low = Math.ceil(r.minSize);
      let high = Math.floor(r.maxSize);
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = attempt(mid);
        if (candidate.fits) {
          best = candidate;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
    }
  }

  const reference = m.ink(best.font, r.align, 'Hg');
  const ascent = reference.ascent;
  const descent = reference.descent;
  const slack = Math.max(0, r.box.height - best.height);
  const top = r.verticalAlign === 'top' ? 0 : r.verticalAlign === 'bottom' ? slack : slack / 2;
  const anchor = r.align === 'left' ? 0 : r.align === 'right' ? r.box.width : r.box.width / 2;
  return {
    fontSize: best.size,
    fits: best.fits,
    font: best.font,
    lines: best.lines.map((text, index) => ({
      text,
      x: anchor,
      y: top + index * best.lineAdvance + (best.lineAdvance - (ascent + descent)) / 2 + ascent,
      width: m.width(best.font, text),
    })),
  };
}
