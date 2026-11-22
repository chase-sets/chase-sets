import { createTranslator } from "@chase-sets/localization/core";
import { authenticityCasesEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: authenticityCasesEnglishTranslations } });
