import { createTranslator } from "@chase-sets/localization/core";
import { paymentStartAndMethodsEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: paymentStartAndMethodsEnglishTranslations } });
