import { createTranslator } from "@chase-sets/localization/core";
import { developerPortalEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: developerPortalEnglishTranslations } });
