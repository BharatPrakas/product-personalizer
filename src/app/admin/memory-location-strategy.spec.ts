import { MemoryLocationStrategy } from './memory-location-strategy';

describe('MemoryLocationStrategy', () => {
  it('keeps history in memory without touching window.history', () => {
    const before = history.length;
    const s = new MemoryLocationStrategy();
    expect(s.path()).toBe('');
    s.pushState(null, '', '/a', '');
    s.pushState(null, '', '/b', 'x=1');
    expect(s.path()).toBe('/b?x=1');
    const seen: unknown[] = [];
    s.onPopState((e) => seen.push(e.type));
    s.back();
    expect(s.path()).toBe('/a');
    s.forward();
    expect(s.path()).toBe('/b?x=1');
    s.back();
    s.pushState(null, '', '/c', ''); // drops the forward entry
    s.forward();
    expect(s.path()).toBe('/c');
    s.replaceState(null, '', '/d', '');
    expect(s.path()).toBe('/d');
    expect(seen.length).toBeGreaterThan(0);
    expect(history.length).toBe(before);
    expect(s.getBaseHref()).toBe('');
  });
});
