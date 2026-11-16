import { describeColor, inkFor, parseHex, swatchViews } from './color-names';

describe('color names for swatches', () => {
  it('parses short and long hex values and rejects everything else', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#112233')).toEqual({ r: 17, g: 34, b: 51 });
    expect(parseHex('#11223380')).toEqual({ r: 17, g: 34, b: 51 });
    expect(parseHex('rgb(0,0,0)')).toBeNull();
    expect(parseHex('#12')).toBeNull();
  });

  it('names the colours shoppers see in the samples', () => {
    expect(describeColor('#111827')).toBe('Navy');
    expect(describeColor('#000000')).toBe('Black');
    expect(describeColor('#ffffff')).toBe('White');
    expect(describeColor('#c2185b')).toBe('Pink');
    expect(describeColor('#e53935')).toBe('Red');
    expect(describeColor('#f5b400')).toBe('Yellow');
    expect(describeColor('#296fd7')).toBe('Blue');
    expect(describeColor('#2e7d32')).toBe('Green');
    expect(describeColor('#6d4c41')).toBe('Brown');
    expect(describeColor('#9e9e9e')).toBe('Grey');
  });

  it('returns values it cannot parse unchanged', () => {
    expect(describeColor(' teal ')).toBe('teal');
  });

  it('draws the selection mark in a colour that contrasts with the swatch', () => {
    expect(inkFor('#ffffff')).toBe('#111827');
    expect(inkFor('#f5b400')).toBe('#111827');
    expect(inkFor('#111827')).toBe('#ffffff');
    expect(inkFor('#c2185b')).toBe('#ffffff');
    expect(inkFor('not-a-colour')).toBe('#ffffff');
  });

  it('keeps names unique within a field by adding the value only where two would collide', () => {
    expect(swatchViews(['#111827', '#ffffff']).map((s) => s.name)).toEqual(['Navy', 'White']);
    expect(swatchViews(['#e53935', '#d32f2f', '#ffffff']).map((s) => s.name)).toEqual([
      'Red (#e53935)',
      'Red (#d32f2f)',
      'White',
    ]);
  });
});
