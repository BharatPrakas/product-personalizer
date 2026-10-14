import { uuid } from './ids';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  it('uses crypto.randomUUID when the page is a secure context', () => {
    expect(
      uuid({ randomUUID: () => 'fixed-id' as `${string}-${string}-${string}-${string}-${string}` }),
    ).toBe('fixed-id');
  });

  it('still produces a valid v4 UUID on an insecure (plain HTTP) page, where randomUUID is missing', () => {
    const insecure = { getRandomValues: crypto.getRandomValues.bind(crypto) } as Partial<Crypto>;
    const ids = Array.from({ length: 50 }, () => uuid(insecure));
    ids.forEach((id) => expect(id).toMatch(V4));
    expect(new Set(ids).size).toBe(50);
  });

  it('falls back to Math.random if there is no crypto at all', () => {
    expect(uuid({} as Partial<Crypto>)).toMatch(V4);
  });
});
