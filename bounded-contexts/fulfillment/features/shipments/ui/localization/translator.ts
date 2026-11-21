import { createTranslator } from "@chase-sets/localization/core";
import { shipmentsEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: shipmentsEnglishTranslations } });
