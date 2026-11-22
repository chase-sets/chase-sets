import { createTranslator } from "@chase-sets/localization/core";
import { savedListsApiEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: savedListsApiEnglishTranslations } });
