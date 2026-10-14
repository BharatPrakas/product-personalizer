/** Text normalisation and counting. Grapheme clusters are counted with `Intl.Segmenter`. */

import type { FieldErrorCode } from '../models/draft.models';

let segmenter: Intl.Segmenter | null | undefined;

/** Grapheme clusters via Intl.Segmenter; engines without it fall back to code points (closest available). */
export function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
}

export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

export function normalizeText(text: string): string {
  return text.normalize('NFC');
}

/** Line breaks in any form: CR, LF, NEL, LS, PS. */
export const NEWLINE_PATTERN = /[\r\n\u{85}\u{2028}\u{2029}]/u;
/** Control characters other than the newlines above. Joiners and variation selectors are fine. */
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f]/;
/**
 * Characters that draw nothing and so can't be probed for glyph support: combining marks, variation
 * selectors and every format character (zero-width space/joiners, direction marks, BOM, soft hyphen).
 */
const INVISIBLE_PATTERN = /^[\p{M}\p{Cf}]$/u;
/** Direction overrides and isolates would reorder what is printed; they are rejected, not drawn. */
const BIDI_CONTROL_PATTERN = /[\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;

export interface TextProblem {
  code: Extract<FieldErrorCode, 'too-long' | 'newline' | 'unsupported-glyph'>;
  message: string;
}

/** Structural problems that don't need a font: newlines, control characters, over-long text. */
export function structuralTextProblems(text: string, maxLength: number): TextProblem[] {
  const problems: TextProblem[] = [];
  if (NEWLINE_PATTERN.test(text)) {
    problems.push({
      code: 'newline',
      message: 'Use a single line; line breaks are not supported.',
    });
  }
  if (CONTROL_PATTERN.test(text)) {
    problems.push({
      code: 'unsupported-glyph',
      message: 'Remove control characters; they cannot be printed.',
    });
  }
  if (BIDI_CONTROL_PATTERN.test(text)) {
    problems.push({
      code: 'unsupported-glyph',
      message: 'Remove text-direction override characters; they are not supported.',
    });
  }
  const count = graphemeCount(text);
  if (count > maxLength) {
    problems.push({
      code: 'too-long',
      message: `Use at most ${maxLength} characters (currently ${count}).`,
    });
  }
  return problems;
}

/** Visible characters (code-point level) that should be checked against a font. */
export function probeableCharacters(text: string): string[] {
  const seen = new Set<string>();
  for (const char of text) {
    if (char.trim() === '' || INVISIBLE_PATTERN.test(char)) continue;
    seen.add(char);
  }
  return [...seen];
}

/** True when the text would draw something: not just spaces, joiners, zero-width or combining marks. */
export function hasVisibleContent(text: string): boolean {
  for (const char of text) {
    if (char.trim() !== '' && !INVISIBLE_PATTERN.test(char)) return true;
  }
  return false;
}
