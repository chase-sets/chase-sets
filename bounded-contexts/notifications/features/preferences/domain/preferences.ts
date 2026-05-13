export type NotificationPreferenceKey = "web" | "email" | "product-alerts";

export type NotificationPreference = Readonly<{
  key: NotificationPreferenceKey;
  enabled: boolean;
}>;

export const defaultNotificationPreferences = [
  { key: "web", enabled: true },
  { key: "email", enabled: true },
  { key: "product-alerts", enabled: true },
] as const satisfies readonly NotificationPreference[];
