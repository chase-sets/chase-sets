import { createTranslator } from "@chase-sets/localization/core";
import { attentionApiEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: attentionApiEnglishTranslations } });
