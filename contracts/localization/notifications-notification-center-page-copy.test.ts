import { describe, expect, it } from "vitest";
import { t } from "./index";
import { notificationsEnglishTranslations } from "./locales/en/notifications";

describe("notification center page copy", () => {
  it("approved notification center page catalog bytes", () => {
    const actual = Object.fromEntries(
      Object.entries(notificationsEnglishTranslations).filter(([key]) =>
        key.startsWith("notifications.features.notificationCenter.ui.page."),
      ),
    );
    expect(actual).toEqual({
      "notifications.features.notificationCenter.ui.page.feed.empty.description":
        "Order, shipment, and Product alert updates will appear here.",
      "notifications.features.notificationCenter.ui.page.feed.empty.title": "No notifications",
      "notifications.features.notificationCenter.ui.page.feed.heading": "Recent updates",
      "notifications.features.notificationCenter.ui.page.feed.label": "Feed",
      "notifications.features.notificationCenter.ui.page.feed.markAllRead": "Mark all read",
      "notifications.features.notificationCenter.ui.page.feed.markRead": "Mark read",
      "notifications.features.notificationCenter.ui.page.feed.new": "New",
      "notifications.features.notificationCenter.ui.page.feed.read": "Read",
      "notifications.features.notificationCenter.ui.page.feed.unread": "{count} unread",
      "notifications.features.notificationCenter.ui.page.heading": "Notifications",
      "notifications.features.notificationCenter.ui.page.loading": "Loading notifications",
      "notifications.features.notificationCenter.ui.page.readFailure.description": "Try again in a moment.",
      "notifications.features.notificationCenter.ui.page.readFailure.retry": "Try again",
      "notifications.features.notificationCenter.ui.page.readFailure.title": "Notifications could not load",
      "notifications.features.notificationCenter.ui.page.settings.label": "Settings",
      "notifications.features.notificationCenter.ui.page.settings.preferences.description":
        "Control how marketplace updates reach this account.",
      "notifications.features.notificationCenter.ui.page.settings.preferences.heading": "Delivery settings",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.delete": "Delete",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.description":
        "Pause or remove watches created from product detail pages.",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.empty.description":
        "Create alerts from product detail pages after choosing product options.",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.empty.title": "No Product alerts yet",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.heading": "Product alerts",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.pause": "Pause",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.resume": "Resume",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.status.active": "active",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.status.paused": "paused",
      "notifications.features.notificationCenter.ui.page.settings.productAlerts.viewProduct": "View product",
    });
    for (const value of Object.values(actual)) {
      expect([...value].filter((character) => character.charCodeAt(0) < 32)).toEqual([]);
    }
    expect(t("notifications.features.notificationCenter.ui.page.feed.unread", { count: 1 })).toBe("1 unread");
    expect(t("notifications.features.notificationCenter.ui.page.feed.unread", { count: 12 })).toBe("12 unread");
  });
});
