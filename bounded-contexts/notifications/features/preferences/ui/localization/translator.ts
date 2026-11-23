import { createTranslator } from "@chase-sets/localization/core";
import type { NotificationPreferenceKey } from "../../domain/preferences";
import { notificationPreferencesEnglishTranslations } from "./locales/en";

const { t } = createTranslator({ catalogs: { en: notificationPreferencesEnglishTranslations } });

type PreferenceCopyKey = keyof typeof notificationPreferencesEnglishTranslations;

const preferenceCopyKeys = {
  web: {
    labelKey: "notifications.features.notificationCenter.ui.shell.preference.web.label",
    descriptionKey: "notifications.features.notificationCenter.ui.shell.preference.web.description",
  },
  email: {
    labelKey: "notifications.features.notificationCenter.ui.shell.preference.email.label",
    descriptionKey: "notifications.features.notificationCenter.ui.shell.preference.email.description",
  },
  "product-alerts": {
    labelKey: "notifications.features.notificationCenter.ui.shell.preference.productAlerts.label",
    descriptionKey: "notifications.features.notificationCenter.ui.shell.preference.productAlerts.description",
  },
} satisfies Record<NotificationPreferenceKey, { labelKey: PreferenceCopyKey; descriptionKey: PreferenceCopyKey }>;

export function getNotificationPreferenceCopy(key: NotificationPreferenceKey) {
  const copy = preferenceCopyKeys[key];
  return copy && { label: t(copy.labelKey), description: t(copy.descriptionKey) };
}

export function invalidNotificationPreferenceMessage() {
  return t("notifications.api.preference.invalid");
}
