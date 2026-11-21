import type { NotificationChannelPreference } from "@chase-sets/outbound-messaging";

export type NotificationPreferenceKey = "web" | "email" | "product-alerts";

export type NotificationPreference = Readonly<{
  key: NotificationPreferenceKey;
  enabled: boolean;
}>;

/** The settings an account can change: the channels it can choose for the messages it may turn off. */
export const defaultNotificationPreferences = [
  { key: "web", enabled: true },
  { key: "email", enabled: true },
  { key: "product-alerts", enabled: true },
] as const satisfies readonly NotificationPreference[];

/**
 * Channels an account cannot choose yet. The platform sends them only messages no preference can
 * stop (a sign-in code by SMS), so they stay off for every other message until they come with
 * their own setting, words and consent.
 */
export const unofferedNotificationChannels = ["sms", "rcs"] as const;

export function isNotificationPreferenceKey(value: string): value is NotificationPreferenceKey {
  return defaultNotificationPreferences.some((preference) => preference.key === value);
}

/** The preferences delivery applies for an account: its settings, and the unoffered channels off. */
export function deliveryChannelPreferences(
  preferences: readonly NotificationPreference[],
): readonly NotificationChannelPreference[] {
  return [
    ...preferences.map(
      (preference): NotificationChannelPreference =>
        preference.key === "product-alerts"
          ? { channel: null, category: "product-alerts", enabled: preference.enabled }
          : { channel: preference.key, enabled: preference.enabled },
    ),
    ...unofferedNotificationChannels.map((channel) => ({ channel, enabled: false })),
  ];
}
