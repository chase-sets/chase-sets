import { createTranslator } from "@chase-sets/localization/core";
import { policiesEnglishTranslations } from "./locales/en";

export const { t, hasTranslation } = createTranslator({ catalogs: { en: policiesEnglishTranslations } });
