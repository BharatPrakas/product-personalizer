import { Pipe, PipeTransform, Service, computed, inject, signal } from '@angular/core';
import { EN, type MessageKey, type Messages, type PluralBase } from './messages.en';
import { AR } from './messages.ar';
import { FR } from './messages.fr';

const CATALOGS: Readonly<Record<string, Messages>> = { fr: FR, ar: AR };
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv']);

/** Primary language subtag of a BCP-47 tag (`pt-BR` -> `pt`); falls back to English. */
export function primaryLanguage(tag: string | null | undefined): string {
  const lang = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(lang) ? lang : 'en';
}

export function isRtl(tag: string | null | undefined): boolean {
  return RTL.has(primaryLanguage(tag));
}

function fill(template: string, params?: Readonly<Record<string, string | number>>): string {
  return params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match,
      )
    : template;
}

function pluralCategory(tag: string, count: number): Intl.LDMLPluralRule {
  try {
    return new Intl.PluralRules(tag).select(count);
  } catch {
    return 'other';
  }
}

/**
 * UI strings of the admin element for the host's `locale`. Messages missing from a language fall
 * back to English; dates and numbers use `Intl` with the same tag.
 */
@Service()
export class I18n {
  readonly tag = signal('en');
  readonly language = computed(() => primaryLanguage(this.tag()));
  readonly dir = computed<'ltr' | 'rtl'>(() => (isRtl(this.tag()) ? 'rtl' : 'ltr'));

  setLocale(tag: string | null | undefined): void {
    const value = (tag ?? '').trim();
    try {
      // Validates the tag; an invalid one keeps the previous locale.
      if (value) new Intl.Locale(value);
      this.tag.set(value || 'en');
    } catch {
      /* keep the current locale */
    }
  }

  t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
    return fill(CATALOGS[this.language()]?.[key] ?? EN[key], params);
  }

  /**
   * Plural-aware message: looks up `<base>.<category>` (zero, one, two, few, many, other) for the
   * count in the current language, then that language's `<base>.other`, then the English forms
   * (chosen with the English plural rules). `{count}` is filled in automatically.
   */
  plural(
    base: PluralBase,
    count: number,
    params?: Readonly<Record<string, string | number>>,
  ): string {
    const values = { count, ...params };
    const own = CATALOGS[this.language()];
    const category = pluralCategory(this.tag(), count);
    const template = own?.[`${base}.${category}`] ?? own?.[`${base}.other`];
    if (template !== undefined) return fill(template, values);
    const exact = `${base}.${pluralCategory('en', count)}`;
    return fill((EN as Record<string, string>)[exact] ?? EN[`${base}.other`], values);
  }

  date(value: number | Date): string {
    try {
      return new Intl.DateTimeFormat(this.tag(), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(value);
    } catch {
      return new Date(value).toLocaleString();
    }
  }
}

/** `{{ 'list.mockups' | tn: count }}`: plural-aware, see `I18n.plural`. */
@Pipe({ name: 'tn', pure: false })
export class PluralPipe implements PipeTransform {
  private readonly i18n = inject(I18n);

  transform(
    base: PluralBase,
    count: number,
    params?: Readonly<Record<string, string | number>>,
  ): string {
    this.i18n.tag();
    return this.i18n.plural(base, count, params);
  }
}

/** `{{ 'mapping.title' | t }}` or `{{ 'mapping.selected' | t: { count: n } }}`; re-evaluates when the locale changes. */
@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18n);

  transform(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
    this.i18n.tag(); // dependency for the template's reactive context
    return this.i18n.t(key, params);
  }
}
