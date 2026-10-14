import { Service } from '@angular/core';
import { FontSpec } from '../models/config.models';
import { CustomizerError, describeUrl } from './errors';

interface GlyphRender {
  width: number;
  pixels: Uint8ClampedArray;
}

/** U+10FFFF is a noncharacter: no font maps it, so it always draws the .notdef glyph. */
const NEVER_ASSIGNED = '\u{10FFFF}';

function sameRender(a: GlyphRender, b: GlyphRender): boolean {
  if (a.width !== b.width) return false;
  for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) return false;
  return true;
}

const PROBE_SIZE = 48;
const PROBE_CANVAS = 96;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Application-wide, immutable font cache. Each font binary is fetched and registered once per
 * URL under an internal family name derived from the URL, so two configurations that reuse a
 * family label for different files can't collide. No per-instance state lives here.
 */
@Service()
export class FontService {
  private readonly families = new Map<string, Promise<string>>();
  private readonly glyphMemo = new Map<string, boolean>();
  private readonly notdefMemo = new Map<string, GlyphRender>();
  private probe: CanvasRenderingContext2D | null = null;

  /** Fetch + register the font; resolves to the canvas font family to use. */
  load(font: FontSpec): Promise<string> {
    let pending = this.families.get(font.src);
    if (!pending) {
      pending = this.register(font);
      this.families.set(font.src, pending);
      // Failures are not cached so a retry (new config assignment) can succeed.
      pending.catch(() => this.families.delete(font.src));
    }
    return pending;
  }

  private async register(font: FontSpec): Promise<string> {
    const family = `zb-${fnv1a(font.src)}-${font.family.replace(/ /g, '_')}`;
    const where = describeUrl(font.src);
    let data: ArrayBuffer;
    try {
      const response = await fetch(font.src, { mode: 'cors', credentials: 'same-origin' });
      if (!response.ok) {
        throw new CustomizerError(
          'font-load-failed',
          `Font "${font.family}" could not be loaded: ${where} returned HTTP ${response.status}.`,
        );
      }
      data = await response.arrayBuffer();
    } catch (error) {
      if (error instanceof CustomizerError) throw error;
      throw new CustomizerError(
        'font-load-failed',
        `Font "${font.family}" could not be loaded from ${where}. Check the path, and that cross-origin fonts are served with CORS headers.`,
      );
    }
    try {
      const face = new FontFace(family, data);
      await face.load();
      document.fonts.add(face);
    } catch {
      throw new CustomizerError(
        'font-load-failed',
        `Font "${font.family}" (${where}) is not a valid font file.`,
      );
    }
    return family;
  }

  /** Characters of `chars` that `family` has no glyph for (memoised; needs a loaded font). */
  missingGlyphs = (family: string, chars: string[]): string[] =>
    chars.filter((char) => !this.supports(family, char));

  /**
   * A glyph is missing when the browser would silently fall back to another font. That shows up
   * as identical rendering with and without the target font in front of the same generic
   * fallback; a real glyph differs from at least one of two unlike fallbacks.
   */
  private supports(family: string, char: string): boolean {
    const key = `${family}\u0000${char}`;
    let result = this.glyphMemo.get(key);
    if (result === undefined) {
      result = this.probeGlyph(family, char);
      this.glyphMemo.set(key, result);
    }
    return result;
  }

  private probeGlyph(family: string, char: string): boolean {
    const ctx = this.probeContext();
    if (!ctx) return true; // can't probe: don't block shoppers on a missing capability

    // A character that no font has is drawn as the first font's .notdef box, which differs from
    // either generic fallback; recognise it by comparing with a code point nothing can have.
    const withTargetSerif = this.render(ctx, `"${family}", serif`, char);
    if (sameRender(withTargetSerif, this.notdefOf(ctx, family))) return false;

    for (const generic of ['serif', 'monospace']) {
      const withTarget =
        generic === 'serif' ? withTargetSerif : this.render(ctx, `"${family}", ${generic}`, char);
      if (!sameRender(withTarget, this.render(ctx, generic, char))) return true;
    }
    return false;
  }

  private notdefOf(ctx: CanvasRenderingContext2D, family: string): GlyphRender {
    let baseline = this.notdefMemo.get(family);
    if (!baseline) {
      baseline = this.render(ctx, `"${family}", serif`, NEVER_ASSIGNED);
      this.notdefMemo.set(family, baseline);
    }
    return baseline;
  }

  private render(ctx: CanvasRenderingContext2D, stack: string, char: string): GlyphRender {
    ctx.clearRect(0, 0, PROBE_CANVAS, PROBE_CANVAS);
    ctx.font = `${PROBE_SIZE}px ${stack}`;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(char, 8, 64);
    return {
      width: ctx.measureText(char).width,
      pixels: ctx.getImageData(0, 0, PROBE_CANVAS, PROBE_CANVAS).data,
    };
  }

  private probeContext(): CanvasRenderingContext2D | null {
    if (!this.probe) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = PROBE_CANVAS;
      this.probe = canvas.getContext('2d', { willReadFrequently: true });
    }
    return this.probe;
  }
}
