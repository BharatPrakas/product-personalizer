import { coerceView, parseUrl, urlFor } from './admin-navigation';

describe('admin navigation', () => {
  it('maps views to in-memory URLs and back', () => {
    expect(urlFor('list', null)).toBe('/configurations');
    expect(urlFor('editor', 'cfg-1')).toBe('/configurations/cfg-1');
    expect(urlFor('editor', null)).toBe('/configurations');
    expect(urlFor('preview', 'cfg-1')).toBe('/preview/cfg-1');
    expect(urlFor('mapping', null)).toBe('/mapping');
    expect(urlFor('mapping', 'cfg-1')).toBe('/mapping/cfg-1');
    for (const [view, id] of [
      ['editor', 'cfg-1'],
      ['preview', 'cfg-1'],
      ['mapping', 'cfg-1'],
      ['mapping', null],
      ['list', null],
    ] as const) {
      expect(parseUrl(urlFor(view, id))).toEqual({ view, configId: id });
    }
  });

  it('ignores ids that could break out of the path', () => {
    expect(urlFor('editor', '../../x')).toBe('/configurations');
    expect(urlFor('editor', 'a/b')).toBe('/configurations');
  });

  it('ignores query strings and falls back to the list', () => {
    expect(parseUrl('/mapping/abc?x=1')).toEqual({ view: 'mapping', configId: 'abc' });
    expect(parseUrl('/nope')).toEqual({ view: 'list', configId: null });
    expect(parseUrl('')).toEqual({ view: 'list', configId: null });
  });

  it('coerces unknown view values', () => {
    expect(coerceView('mapping')).toBe('mapping');
    expect(coerceView('bogus')).toBe('list');
    expect(coerceView(undefined)).toBe('list');
  });
});
