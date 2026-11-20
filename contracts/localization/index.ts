import { englishTranslations } from "./locales/en";
import {
  createTranslator as createCoreTranslator,
  formatDisplayIdentity as formatCoreDisplayIdentity,
  formatLanguageCodeLabel as formatCoreLanguageCodeLabel,
  type SupportedLocale,
  type TranslationCatalog,
  type Translate,
  type Translator,
  type TranslatorOptions as CoreTranslatorOptions,
} from "./core";

export * from "./core";
export {
  authenticationMethodLabel,
  authenticationMethodValues,
  formatMachineValue,
  humanizeMachineToken,
  safeMachineToken,
  type MachineValueLabelOptions,
} from "./machine-value";

export interface TranslatorOptions extends Omit<CoreTranslatorOptions, "catalogs" | "locale"> {
  locale?: SupportedLocale;
}

export const translationCatalogs: Record<SupportedLocale, TranslationCatalog> = {
  en: englishTranslations,
};

export function createTranslator(options: TranslatorOptions = {}): Translator {
  return createCoreTranslator({ ...options, catalogs: translationCatalogs });
}

const defaultTranslator = createTranslator();
export const t = defaultTranslator.t;
export const hasTranslation = defaultTranslator.has;

export function formatDisplayIdentity(
  title: string | null | undefined,
  subtitle: string | null | undefined,
  translate: Translate = t,
): string {
  return formatCoreDisplayIdentity(title, subtitle, translate);
}

export function formatLanguageCodeLabel(languageCode: string | null | undefined, translate: Translate = t): string {
  return formatCoreLanguageCodeLabel(languageCode, translate);
}
