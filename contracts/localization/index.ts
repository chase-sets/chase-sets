import { englishTranslations } from "./locales/en";

export const supportedLocales = ["en"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];
export type TranslationCatalog = Readonly<Record<string, string>>;
export type TranslationValues = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface MissingTranslation {
  locale: SupportedLocale;
  key: string;
}

export interface TranslatorOptions {
  locale?: SupportedLocale;
  onMissingTranslation?: (missing: MissingTranslation) => void;
}

export interface Translator {
  locale: SupportedLocale;
  t: (key: string, values?: TranslationValues) => string;
  has: (key: string) => boolean;
}

export const translationCatalogs: Record<SupportedLocale, TranslationCatalog> = {
  en: englishTranslations,
};

export const defaultLocale: SupportedLocale = "en";

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return supportedLocales.includes(locale as SupportedLocale);
}

export function resolveLocale(locale?: string | null): SupportedLocale {
  return locale && isSupportedLocale(locale) ? locale : defaultLocale;
}

export function createTranslator({
  locale = defaultLocale,
  onMissingTranslation,
}: TranslatorOptions = {}): Translator {
  const catalog = translationCatalogs[locale];

  function has(key: string) {
    return Object.prototype.hasOwnProperty.call(catalog, key);
  }

  function t(key: string, values: TranslationValues = {}) {
    const template = catalog[key];

    if (template === undefined) {
      onMissingTranslation?.({ locale, key });
      return `[missing:${locale}:${key}]`;
    }

    return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, token: string) => {
      const value = values[token];
      return value === undefined || value === null ? match : String(value);
    });
  }

  return { locale, t, has };
}

const defaultTranslator = createTranslator();

export const t = defaultTranslator.t;
export const hasTranslation = defaultTranslator.has;
