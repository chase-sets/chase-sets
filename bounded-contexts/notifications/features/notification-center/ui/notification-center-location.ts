export const notificationCenterPath = "/account/notifications";

export type NotificationCenterSettingsSection = "preferences" | "product-alerts";

export type NotificationCenterLocation =
  | Readonly<{ view: "feed" }>
  | Readonly<{ view: "settings"; section: NotificationCenterSettingsSection }>;

function isSettingsSection(value: string | null): value is NotificationCenterSettingsSection {
  return value === "preferences" || value === "product-alerts";
}

export function readNotificationCenterLocation(searchParams: URLSearchParams): NotificationCenterLocation {
  if (searchParams.get("view") !== "settings") {
    return { view: "feed" };
  }

  const section = searchParams.get("section");
  return { view: "settings", section: isSettingsSection(section) ? section : "preferences" };
}

export const notificationCenterSettingsHref = `${notificationCenterPath}?view=settings`;

/**
 * Maps the retired sheet query state (`notifications=feed|settings` plus an optional
 * `notificationSection`) on any marketplace page to the fixed notification-center route.
 * Returns null when the URL carries no recognized sheet state. Other query parameters are
 * never carried over, so the destination is always a local, fixed path.
 */
export function resolveLegacyNotificationCenterHref(url: URL): string | null {
  const state = url.searchParams.get("notifications");

  if (state === "feed") {
    return notificationCenterPath;
  }

  if (state !== "settings") {
    return null;
  }

  const section = url.searchParams.get("notificationSection");
  return isSettingsSection(section)
    ? `${notificationCenterSettingsHref}&section=${section}`
    : notificationCenterSettingsHref;
}
