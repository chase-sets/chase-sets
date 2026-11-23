import { createTranslator } from "@chase-sets/localization/core";
import { policiesEnglishTranslations } from "./locales/en";

export const { t, has } = createTranslator({ catalogs: { en: policiesEnglishTranslations } });
