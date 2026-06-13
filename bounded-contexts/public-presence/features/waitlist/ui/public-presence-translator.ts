import type { TranslationValues } from "@chase-sets/localization";
import { publicPresenceEnglishTranslations } from "@chase-sets/localization/locales/en/public-presence";

const catalog: Readonly<Record<string, string>> = publicPresenceEnglishTranslations;
const locale = "en";

export function publicPresenceHasTranslation(key: string) {
  return Object.prototype.hasOwnProperty.call(catalog, key);
}

export function publicPresenceT(key: string, values: TranslationValues = {}) {
  const template = catalog[key];

  if (template === undefined) {
    return `[missing:${locale}:${key}]`;
  }

  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, token: string) => {
    const value = values[token];
    return value === undefined || value === null ? match : String(value);
  });
}
