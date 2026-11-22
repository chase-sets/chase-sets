import { createTranslator } from "@chase-sets/localization/core";
import { notificationCenterEnglishTranslations } from "./locales/en";

export const { t } = createTranslator({ catalogs: { en: notificationCenterEnglishTranslations } });
