export type NotificationPreferenceKey =
  | "web"
  | "email"
  | "sms"
  | "rcs"
  | "product-alerts";

export type NotificationPreference = Readonly<{
  key: NotificationPreferenceKey;
  enabled: boolean;
}>;

export const defaultNotificationPreferences = [
  { key: "web", enabled: true },
  { key: "email", enabled: true },
  { key: "sms", enabled: false },
  { key: "rcs", enabled: false },
  { key: "product-alerts", enabled: true },
] as const satisfies readonly NotificationPreference[];
