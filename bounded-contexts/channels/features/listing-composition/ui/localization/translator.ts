import { createTranslator } from "@chase-sets/localization/core";
import { listingCompositionEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: listingCompositionEnglishTranslations } });
