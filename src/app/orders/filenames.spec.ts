import { UniqueNames, extensionFor, fileName, sanitizeSegment } from './filenames';

describe('archive file names', () => {
  it('removes path traversal, separators and control characters', () => {
    expect(sanitizeSegment('../../etc/passwd')).toBe('-..-etc-passwd'); // one segment: no separator survives
    expect(sanitizeSegment('..')).toBe('file');
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeSegment('line\u0000one\nnew‮evil')).toBe('lineonenewevil');
    expect(sanitizeSegment('  .hidden  ')).toBe('hidden');
    expect(sanitizeSegment('trailing. ')).toBe('trailing');
  });

  it('never returns an empty or reserved name and bounds the length', () => {
    expect(sanitizeSegment('', 'area')).toBe('area');
    expect(sanitizeSegment(null, 'area')).toBe('area');
    expect(sanitizeSegment('///', '')).toBe('-');
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('lpt1.txt')).toBe('_lpt1.txt');
    expect(sanitizeSegment('x'.repeat(500)).length).toBe(80);
  });

  it('keeps readable Unicode names', () => {
    expect(sanitizeSegment('Façade — avant')).toBe('Façade — avant');
    expect(sanitizeSegment('الواجهة')).toBe('الواجهة');
  });

  it('builds file names with a clean extension', () => {
    expect(fileName('Front', 'png')).toBe('Front.png');
    expect(fileName('../Front', 'P.N/G')).toBe('-Front.png');
    expect(fileName('', 'jpg', 'upload')).toBe('upload.jpg');
    expect(fileName('x'.repeat(200), 'png').length).toBeLessThanOrEqual(80);
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('IMAGE/PNG; charset=binary')).toBe('png');
    expect(extensionFor('application/x-unknown')).toBe('bin');
  });

  it('de-duplicates names case-insensitively within a folder', () => {
    const names = new UniqueNames();
    expect(names.claim('Front.png')).toBe('Front.png');
    expect(names.claim('front.png')).toBe('front (2).png');
    expect(names.claim('Front.png')).toBe('Front (3).png');
    expect(names.claim('README')).toBe('README');
    expect(names.claim('readme')).toBe('readme (2)');
  });
});
