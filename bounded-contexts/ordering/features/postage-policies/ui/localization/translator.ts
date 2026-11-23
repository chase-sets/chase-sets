import { createTranslator } from "@chase-sets/localization/core";
import { postagePoliciesEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: postagePoliciesEnglishTranslations } });
