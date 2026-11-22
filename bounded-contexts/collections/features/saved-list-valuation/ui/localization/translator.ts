import { createTranslator } from "@chase-sets/localization/core";
import { savedListValuationUiEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: savedListValuationUiEnglishTranslations } });
