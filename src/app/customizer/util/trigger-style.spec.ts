import {
  DEFAULT_TRIGGER_LABEL,
  coerceTriggerStyle,
  contrastRatio,
  parseColor,
  resolveTriggerStyle,
  toRgba,
} from './trigger-style';

describe('coerceTriggerStyle', () => {
  it('takes an object, or JSON as an attribute carries it', () => {
    expect(coerceTriggerStyle({ buttonColor: '#fff' })).toEqual({ buttonColor: '#fff' });
    expect(coerceTriggerStyle('{"buttonColor":"#fff"}')).toEqual({ buttonColor: '#fff' });
  });

  it('refuses everything else', () => {
    for (const value of [null, undefined, 5, true, [], ['a'], '', '  ', 'not json', '[1]', '"str"', 'x'.repeat(5000)]) {
      expect(coerceTriggerStyle(value)).toBeNull();
    }
  });
});

describe('parseColor', () => {
  it('accepts hex, rgb(a), hsl(a) and plain names', () => {
    for (const ok of ['#fff', '#FFFF', '#112233', '#11223344', 'rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'rgb(1 2 3 / 50%)', 'hsl(120, 50%, 40%)', 'red', 'transparent']) {
      expect(parseColor(ok)).not.toBeNull();
    }
  });

  it('rejects anything that could carry more than a colour', () => {
    const hostile = [
      'url(https://evil.example/x.png)',
      'var(--secret)',
      'red; background: url(x)',
      'red} body{display:none',
      'expression(alert(1))',
      'rgb(1,2,3); x:y',
      'rgb(var(--x))',
      '#12',
      '#12345',
      '#gggggg',
      'inherit',
      'initial',
      'unset',
      'calc(1px)',
      '\\72 ed',
      'red\n;',
      '<script>',
      '',
      '   ',
      42,
      null,
      {},
      'a'.repeat(100),
    ];
    for (const value of hostile) expect(parseColor(value)).toBeNull();
  });
});

describe('toRgba / contrastRatio', () => {
  it('reads hex, rgb and hsl', () => {
    expect(toRgba('#ff0000')).toEqual([255, 0, 0, 1]);
    expect(toRgba('#f00')).toEqual([255, 0, 0, 1]);
    expect(toRgba('rgb(0, 128, 255)')).toEqual([0, 128, 255, 1]);
    expect(toRgba('rgba(0,0,0,.5)')).toEqual([0, 0, 0, 0.5]);
    expect(toRgba('hsl(0, 100%, 50%)')).toEqual([255, 0, 0, 1]);
    expect(toRgba('transparent')).toEqual([0, 0, 0, 0]);
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 0);
    expect(contrastRatio([255, 255, 255, 1], [255, 255, 255, 1])).toBeCloseTo(1, 5);
  });
});

describe('resolveTriggerStyle', () => {
  it('has no variables and the default label for nothing', () => {
    for (const none of [null, undefined, {}, 'garbage', 7]) {
      expect(resolveTriggerStyle(none)).toEqual({ label: null, align: 'start', vars: {} });
    }
    expect(DEFAULT_TRIGGER_LABEL).toBe('Personalize');
  });

  it('maps Builder button properties to custom properties', () => {
    const appearance = resolveTriggerStyle({
      buttonText: '  Design it  ',
      buttonColor: '#0a5c36',
      buttonTextColor: '#ffffff',
      buttonFont: 'Open Sans, serif',
      buttonTextSize: 18,
      buttonTextFontStyle: ['B', 'U'],
      buttonRadius: 12,
      buttonPadding: 10,
      width: 320,
      buttonAlignment: 'center',
      buttonBorderColor: '#111111',
      buttonBorderThickness: 2,
      borderStyle: 'dashed',
      buttonHoverColor: '#083d24',
      buttonHoverTextColor: '#ffffff',
    });
    expect(appearance.label).toBe('Design it');
    expect(appearance.align).toBe('center');
    expect(appearance.vars).toMatchObject({
      '--zbt-bg': '#0a5c36',
      '--zbt-color': '#ffffff',
      '--zbt-font': '"Open Sans", serif, system-ui, sans-serif',
      '--zbt-size': '18px',
      '--zbt-weight': '700',
      '--zbt-decoration': 'underline',
      '--zbt-fstyle': 'normal',
      '--zbt-radius': '12px 12px 12px 12px',
      '--zbt-pad-block': '10px',
      '--zbt-pad-inline': '20px',
      '--zbt-width': '320px',
      '--zbt-bw': '2px 2px 2px 2px',
      '--zbt-bs': 'dashed',
      '--zbt-bc': '#111111',
      '--zbt-hover-bg': '#083d24',
      '--zbt-hover-color': '#ffffff',
    });
  });

  it('draws only the listed corners and sides', () => {
    const { vars } = resolveTriggerStyle({
      buttonRadius: 8,
      borderRadiusPositions: ['TL', 'br'],
      buttonBorderThickness: 3,
      buttonBorderPositions: ['B'],
    });
    expect(vars['--zbt-radius']).toBe('8px 0px 8px 0px');
    expect(vars['--zbt-bw']).toBe('0px 0px 3px 0px');
  });

  it('accepts numeric strings and px, and bounds numbers', () => {
    expect(resolveTriggerStyle({ buttonTextSize: '16px' }).vars['--zbt-size']).toBe('16px');
    for (const bad of [-1, 0, 7, 73, 1e9, NaN, Infinity, '16em', 'calc(1px)', '16px; x:y', {}, [], null]) {
      expect(resolveTriggerStyle({ buttonTextSize: bad }).vars['--zbt-size']).toBeUndefined();
    }
    expect(resolveTriggerStyle({ width: 'full' }).vars['--zbt-width']).toBe('100%');
    expect(resolveTriggerStyle({ width: 5 }).vars['--zbt-width']).toBeUndefined();
  });

  it('ignores hostile colours, fonts and keywords but keeps the valid fields next to them', () => {
    const { vars, label } = resolveTriggerStyle({
      buttonColor: 'url(javascript:alert(1))',
      buttonTextColor: 'var(--x)',
      buttonFont: 'Evil; background:url(x)',
      buttonBorderColor: 'red}',
      borderStyle: 'groove; x',
      buttonBorderThickness: 2,
      buttonText: '<img src=x onerror=alert(1)>',
      buttonRadius: 6,
    });
    expect(vars['--zbt-bg']).toBeUndefined();
    expect(vars['--zbt-color']).toBeUndefined();
    expect(vars['--zbt-font']).toBeUndefined();
    expect(vars['--zbt-bc']).toBeUndefined();
    expect(vars['--zbt-bs']).toBe('solid');
    expect(vars['--zbt-radius']).toBe('6px 6px 6px 6px');
    // The label is plain text; the template binds it as text, never as HTML.
    expect(label).toBe('<img src=x onerror=alert(1)>');
    for (const value of Object.values(vars)) expect(value).not.toMatch(/[;{}<>]|url\(|var\(/i);
  });

  it('keeps every value inside a single declaration, whatever the input', () => {
    const noise = ['a;b', 'a}b', 'a{b', 'a/*b*/c', 'a\\b', 'a"b', "a'b", 'a<b>', 'a\nb', 'url(x)', 'var(--x)', 'expression(1)', '\u0000'];
    for (const value of noise) {
      const { vars } = resolveTriggerStyle({
        buttonColor: value, buttonTextColor: value, buttonFont: value, buttonBorderColor: value, buttonHoverColor: value,
        buttonHoverTextColor: value, buttonBorderHoverColor: value, buttonDisabledColor: value, borderStyle: value,
        buttonAlignment: value, buttonTextFontStyle: [value], buttonText: undefined,
      });
      expect(vars).toEqual({});
    }
  });

  it('limits and cleans the label', () => {
    expect(resolveTriggerStyle({ buttonText: 'x'.repeat(200) }).label).toHaveLength(60);
    expect(resolveTriggerStyle({ buttonText: 'a\n\tb\u0007c' }).label).toBe('a b c');
    expect(resolveTriggerStyle({ buttonText: '   ' }).label).toBeNull();
    expect(resolveTriggerStyle({ buttonText: 5 }).label).toBeNull();
  });

  it('maps alignment, with start as the default', () => {
    expect(resolveTriggerStyle({ buttonAlignment: 'right' }).align).toBe('end');
    expect(resolveTriggerStyle({ buttonAlignment: 'END' }).align).toBe('end');
    expect(resolveTriggerStyle({ buttonAlignment: 'left' }).align).toBe('start');
    expect(resolveTriggerStyle({ buttonAlignment: 'diagonal' }).align).toBe('start');
  });

  it('keeps text readable: a text colour below 4.5:1 is replaced', () => {
    // White on yellow is unreadable; the dark text colour takes over.
    expect(resolveTriggerStyle({ buttonColor: '#ffeb3b', buttonTextColor: '#ffffff' }).vars['--zbt-color']).toBe('#111827');
    // Only a background: the default (white) text is checked against it as well.
    expect(resolveTriggerStyle({ buttonColor: '#ffeb3b' }).vars['--zbt-color']).toBe('#111827');
    // A pair that already passes is left alone.
    expect(resolveTriggerStyle({ buttonColor: '#0a5c36', buttonTextColor: '#ffffff' }).vars['--zbt-color']).toBe('#ffffff');
    // Dark on dark flips to white.
    expect(resolveTriggerStyle({ buttonColor: '#101010', buttonTextColor: '#202020' }).vars['--zbt-color']).toBe('#ffffff');
    // A transparent background has no known surface to measure against.
    expect(resolveTriggerStyle({ buttonColor: 'transparent', buttonTextColor: '#ffffff' }).vars['--zbt-color']).toBe('#ffffff');
  });

  it('checks the hover pair the same way, and honours isButtonHoverEffect: false', () => {
    const hover = resolveTriggerStyle({ buttonColor: '#0a5c36', buttonHoverColor: '#ffeb3b', buttonHoverTextColor: '#ffffff' });
    expect(hover.vars['--zbt-hover-bg']).toBe('#ffeb3b');
    expect(hover.vars['--zbt-hover-color']).toBe('#111827');
    const off = resolveTriggerStyle({ buttonHoverColor: '#ffeb3b', isButtonHoverEffect: false });
    expect(off.vars['--zbt-hover-bg']).toBeUndefined();
  });

  it('uses the resolver for names it cannot read itself', () => {
    const resolver = (value: string) => (value === 'rebeccapurple' ? ([102, 51, 153, 1] as const) : null);
    expect(resolveTriggerStyle({ buttonColor: 'rebeccapurple', buttonTextColor: '#000000' }, resolver).vars['--zbt-color']).toBe('#ffffff');
  });

  it('reads the disabled appearance', () => {
    const { vars } = resolveTriggerStyle({ buttonDisabledColor: '#cccccc', buttonDisabledTextColor: '#666666', buttonDisabledBorderColor: '#999999' });
    expect(vars).toEqual({ '--zbt-dis-bg': '#cccccc', '--zbt-dis-color': '#666666', '--zbt-dis-bc': '#999999', '--zbt-dis-opacity': '1' });
  });
});
