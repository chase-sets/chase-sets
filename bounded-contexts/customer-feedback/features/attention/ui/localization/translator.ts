import { createTranslator } from "@chase-sets/localization/core";
import { feedbackAttentionEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: feedbackAttentionEnglishTranslations } });
