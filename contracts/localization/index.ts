import { englishTranslations } from "./locales/en";

export const supportedLocales = ["en"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];
export type TranslationCatalog = Readonly<Record<string, string>>;
export type TranslationValues = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type LocalizedTextMap = Readonly<{
  defaultLocale: "en";
  values: Readonly<Record<string, string>>;
}>;

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

export function localizedTextMapFromString(value: string): LocalizedTextMap {
  const trimmed = value.trim();

  return {
    defaultLocale,
    values: trimmed ? { en: trimmed } : {},
  };
}

export function coerceLocalizedTextMap(value: unknown): LocalizedTextMap {
  if (typeof value === "string") {
    return localizedTextMapFromString(value);
  }

  if (typeof value !== "object" || value === null) {
    return localizedTextMapFromString("");
  }

  const candidate = value as {
    defaultLocale?: unknown;
    values?: unknown;
  };
  const values =
    typeof candidate.values === "object" && candidate.values !== null
      ? Object.fromEntries(
          Object.entries(candidate.values).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" &&
              typeof entry[1] === "string" &&
              entry[1].trim().length > 0,
          ),
        )
      : {};

  return {
    defaultLocale,
    values,
  };
}

export function resolveLocalizedTextMap(
  value: LocalizedTextMap,
  locale: string = defaultLocale,
): string {
  return value.values[locale] ?? value.values[value.defaultLocale] ?? value.values.en ?? "";
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
