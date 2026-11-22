import { createTranslator } from "@chase-sets/localization/core";
import { returnShipmentsEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: returnShipmentsEnglishTranslations } });
