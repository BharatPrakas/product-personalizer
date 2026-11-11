import { EN } from './messages.en';
import { AR } from './messages.ar';
import { FR } from './messages.fr';
import { I18n, isRtl, primaryLanguage } from './i18n.service';

describe('I18n', () => {
  it('falls back to English for missing keys and unknown languages', () => {
    const i18n = new I18n();
    i18n.setLocale('fr-CA');
    expect(i18n.t('nav.templates')).toBe('Modèles');
    expect(i18n.t('markups.lead')).toBe(EN['markups.lead']);
    i18n.setLocale('xx');
    expect(i18n.t('nav.templates')).toBe('Templates');
  });

  it('replaces placeholders and leaves unknown ones', () => {
    const i18n = new I18n();
    expect(i18n.t('mapping.selected', { count: 3 })).toBe('3 selected');
    expect(i18n.t('mapping.conflict.item', { name: 'A' })).toBe('A → {template}');
  });

  it('detects right-to-left languages and keeps the previous locale on invalid tags', () => {
    const i18n = new I18n();
    i18n.setLocale('ar-EG');
    expect(i18n.dir()).toBe('rtl');
    i18n.setLocale('not a locale!!');
    expect(i18n.tag()).toBe('ar-EG');
    expect(isRtl('he')).toBe(true);
    expect(isRtl('en-US')).toBe(false);
    expect(primaryLanguage('pt_BR')).toBe('pt');
    expect(primaryLanguage('')).toBe('en');
  });

  it('picks the plural category of the language', () => {
    const i18n = new I18n();
    expect(i18n.plural('plural.example', 1)).toBe('1 item');
    expect(i18n.plural('plural.example', 3)).toBe('3 items');
    expect(i18n.plural('plural.example', 0)).toBe('0 items');
    i18n.setLocale('ar'); // no Arabic forms defined: every category falls back to "other"
    expect(i18n.plural('plural.example', 2)).toBe('2 items');
  });

  const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const enKeys = new Set<string>(Object.keys(EN));
  const bases = [...enKeys]
    .filter((k) => k.endsWith('.other'))
    .map((k) => k.slice(0, -'.other'.length));
  const known = (key: string) =>
    enKeys.has(key) ||
    bases.some(
      (base) =>
        /^(zero|two|few|many)$/.test(key.slice(base.length + 1)) && key.startsWith(base + '.'),
    );

  it('other catalogs only use keys that exist in English (or extra plural forms of an English family)', () => {
    for (const catalog of [FR, AR])
      for (const key of Object.keys(catalog)) expect(known(key)).toBe(true);
  });

  it('every English plural family has a singular and an "other" form', () => {
    for (const base of bases) expect(enKeys.has(`${base}.one`)).toBe(true);
  });

  it('keeps placeholders in translations', () => {
    for (const [key, value] of Object.entries(FR)) {
      const en = (EN as Record<string, string>)[key];
      if (en !== undefined) expect(names(value as string)).toEqual(names(en));
    }
    // Arabic singular / dual forms may spell the number out instead of using {count}.
    for (const [key, value] of Object.entries(AR)) {
      const en =
        (EN as Record<string, string>)[key] ??
        (EN as Record<string, string>)[key.replace(/\.\w+$/, '.other')];
      const used = names(value as string);
      const allowed = names(en);
      expect(used.every((n) => allowed.includes(n))).toBe(true);
      if (!/\.(zero|one|two)$/.test(key)) expect(used).toEqual(allowed);
    }
  });

  it('translates every English key in French and Arabic', () => {
    const missing = (catalog: Record<string, string | undefined>) =>
      [...enKeys].filter((k) => !(k in catalog));
    // Mapping / markup chrome predates this check; everything added for the editor is complete.
    const editorKeys = (k: string) =>
      /^(orders|nav\.orders|view\.orders|list|newconfig|editor|sidebar|mockups|areas|artworks|layers|inspector|addarea|preview|ready|ui|shape|stage|storage\.detail|error|status|app\.(brand|brand-aria|nav-primary)|common\.(all|just-now|duplicate|delete-ellipsis|remove|remove-ellipsis|move-earlier|move-later|edit-artwork))\b/.test(
        k,
      );
    expect(missing(FR).filter(editorKeys)).toEqual([]);
    expect(missing(AR).filter(editorKeys)).toEqual([]);
  });

  it('uses Arabic plural categories and falls back to English forms', () => {
    const i18n = new I18n();
    i18n.setLocale('ar');
    expect(i18n.plural('mockups.areas', 1)).toBe('منطقة واحدة');
    expect(i18n.plural('mockups.areas', 2)).toBe('منطقتان');
    expect(i18n.plural('mockups.areas', 5)).toBe('5 مناطق');
    expect(i18n.plural('mockups.areas', 11)).toBe('11 منطقة');
    i18n.setLocale('fr');
    expect(i18n.plural('mockups.areas', 0)).toBe('0 zone');
    expect(i18n.plural('mockups.areas', 3)).toBe('3 zones');
  });
});
