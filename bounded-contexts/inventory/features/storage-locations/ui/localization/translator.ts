import { createTranslator } from "@chase-sets/localization/core";
import { storageLocationsEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: storageLocationsEnglishTranslations } });
