import {
  graphemeCount,
  graphemes,
  hasVisibleContent,
  normalizeText,
  probeableCharacters,
  structuralTextProblems,
} from './text-utils';

describe('grapheme counting (F02)', () => {
  it('counts user-perceived characters, not UTF-16 units', () => {
    expect(graphemeCount('Alex')).toBe(4);
    expect(graphemeCount('👨\u{200d}👩\u{200d}👧')).toBe(1); // family emoji is one cluster of 5 code points
    expect(graphemeCount('🇮🇳')).toBe(1);
    expect(graphemeCount('e\u{301}')).toBe(1);
    expect(graphemeCount('')).toBe(0);
  });

  it('splits into clusters', () => {
    expect(graphemes('a👍🏽b')).toEqual(['a', '👍🏽', 'b']);
  });

  it('normalises to NFC', () => {
    expect(normalizeText('e\u{301}')).toBe('\u{e9}');
    expect(normalizeText('e\u{301}').length).toBe(1);
  });
});

describe('structuralTextProblems', () => {
  it('rejects every kind of line break instead of removing it', () => {
    for (const text of ['a\nb', 'a\r\nb', 'a\rb', 'a\u0085b', 'a\u{2028}b', 'a\u{2029}b']) {
      expect(structuralTextProblems(text, 50).map((p) => p.code)).toContain('newline');
    }
  });

  it('rejects control characters', () => {
    expect(structuralTextProblems('a\u0007b', 50).map((p) => p.code)).toContain(
      'unsupported-glyph',
    );
    expect(structuralTextProblems('a\u0000b', 50).map((p) => p.code)).toContain(
      'unsupported-glyph',
    );
  });

  it('allows joiners and variation selectors used by emoji', () => {
    expect(structuralTextProblems('👨\u{200d}👩\u{200d}👧 ☺\u{fe0f}', 50)).toEqual([]);
  });

  it('flags text over the grapheme limit without truncating it', () => {
    const problems = structuralTextProblems('a'.repeat(25), 24);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: 'too-long' });
    expect(problems[0].message).toContain('25');
    expect(structuralTextProblems('a'.repeat(24), 24)).toEqual([]);
  });

  it('counts clusters against the limit (one family emoji is one character)', () => {
    expect(structuralTextProblems('👨\u{200d}👩\u{200d}👧'.repeat(3), 3)).toEqual([]);
    expect(structuralTextProblems('👨\u{200d}👩\u{200d}👧'.repeat(4), 3)).toHaveLength(1);
  });
});

describe('probeableCharacters', () => {
  it('lists distinct visible characters, skipping spaces, marks and joiners', () => {
    expect(probeableCharacters('Hello  Hello')).toEqual(['H', 'e', 'l', 'o']);
    expect(probeableCharacters('x\u{200d}y\u{fe0f}\u{301}')).toEqual(['x', 'y']);
  });
});

describe('invisible and direction characters', () => {
  it('does not probe format characters such as direction marks, BOM and zero-width space', () => {
    expect(probeableCharacters('a\u{200e}b\u{200f}\u{feff}\u{200b}\u{ad}')).toEqual(['a', 'b']);
  });

  it('rejects direction overrides and isolates, which would reorder printed text', () => {
    for (const mark of ['\u{202e}', '\u{202a}', '\u{2066}', '\u{2069}']) {
      const problems = structuralTextProblems(`ab${mark}cd`, 50);
      expect(problems.map((p) => p.code)).toEqual(['unsupported-glyph']);
      expect(problems[0].message).toContain('direction');
    }
  });

  it('accepts harmless direction marks (they draw nothing)', () => {
    expect(structuralTextProblems('a\u{200e}b\u{200f}c', 50)).toEqual([]);
  });

  it('hasVisibleContent: only drawn characters count', () => {
    expect(hasVisibleContent('Alex')).toBe(true);
    expect(hasVisibleContent('  Alex ')).toBe(true);
    expect(hasVisibleContent('')).toBe(false);
    expect(hasVisibleContent('   ')).toBe(false);
    expect(hasVisibleContent('\u{a0}\u{3000}')).toBe(false); // no-break and ideographic spaces
    expect(hasVisibleContent('\u{200b}\u{200c}\u{200d}\u{feff}')).toBe(false);
    expect(hasVisibleContent('\u{301}')).toBe(false); // a lone combining mark
    expect(hasVisibleContent('\u{200b}x')).toBe(true);
  });
});
