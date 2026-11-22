import { createTranslator } from "@chase-sets/localization/core";
import { savedListValuationApiEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: savedListValuationApiEnglishTranslations } });
