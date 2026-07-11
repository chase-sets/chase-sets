import { englishTranslations } from "./locales/en";

export { formatMoney, type FormatMoneyOptions } from "./money";

export const supportedLocales = ["en"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];
export type TranslationCatalog = Readonly<Record<string, string>>;
export type TranslationValues = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type LocalizedTextMap = Readonly<{
  defaultLocale: "en";
  values: Readonly<Record<string, string>>;
}>;

export type NormalizeLocalizedTextMapOptions = Readonly<{
  requiredEnglish?: boolean;
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

export type Translate = Translator["t"];

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

export function localizedTextMapFromEnglish(value: string): LocalizedTextMap {
  return normalizeLocalizedTextMap({
    defaultLocale,
    values: { en: value },
  });
}

export function normalizeLocaleCode(locale: string): string {
  const trimmed = locale.trim();

  if (!trimmed) {
    throw new Error("Locale codes are required.");
  }

  if (trimmed.toLowerCase() === "jp") {
    throw new Error('Use the BCP 47 language code "ja" for Japanese.');
  }

  const [language = "", ...rest] = trimmed.split("-");
  const normalized = [
    language.toLowerCase(),
    ...rest.map((part, index) =>
      index === 0 && part.length === 4
        ? part[0].toUpperCase() + part.slice(1).toLowerCase()
        : part.length === 2
          ? part.toUpperCase()
          : part.toLowerCase(),
    ),
  ].join("-");

  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)) {
    throw new Error("Locale codes must be valid BCP 47 language tags.");
  }

  return normalized;
}

export function normalizeLocalizedTextMap(
  value: LocalizedTextMap,
  options: NormalizeLocalizedTextMapOptions = {},
): LocalizedTextMap {
  if (value.defaultLocale !== defaultLocale) {
    throw new Error("Localized text maps currently require English as the default locale.");
  }

  const values = Object.fromEntries(
    Object.entries(value.values)
      .map(([locale, text]) => [normalizeLocaleCode(locale), text.trim()] as const)
      .filter(([, text]) => text.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  if (options.requiredEnglish && !values.en) {
    throw new Error("Localized text maps require an English value.");
  }

  return {
    defaultLocale,
    values,
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
              typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0,
          ),
        )
      : {};

  return normalizeLocalizedTextMap({
    defaultLocale,
    values,
  });
}

export function resolveLocalizedTextMap(
  value: LocalizedTextMap | null | undefined,
  locale: string = defaultLocale,
): string {
  if (!value) {
    return "";
  }

  const requestedLocale = normalizeLocaleCode(locale);

  return value.values[requestedLocale] ?? value.values[value.defaultLocale] ?? value.values.en ?? "";
}

export function localizedTextMapValues(value: LocalizedTextMap | null | undefined): string[] {
  return value ? Object.values(value.values).filter(Boolean) : [];
}

export function createTranslator({ locale = defaultLocale, onMissingTranslation }: TranslatorOptions = {}): Translator {
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

export function formatLanguageCodeLabel(languageCode: string | null | undefined, translate: Translate = t): string {
  const code = languageCode?.trim();

  if (!code) {
    return "";
  }

  switch (code.toLowerCase()) {
    case "en":
      return translate("localization.languageCode.en");
    case "ja":
      return translate("localization.languageCode.ja");
    default:
      return code;
  }
}
