import { describe, expect, it } from "vitest";
import { t } from "./index";
import { notificationsEnglishTranslations } from "./locales/en/notifications";

describe("buyer cancellation copy", () => {
  it("approved cancellation catalog bytes", () => {
    const actual = Object.fromEntries(
      Object.entries(notificationsEnglishTranslations).filter(([key]) =>
        key.startsWith("notifications.intents.orderCancelled."),
      ),
    );
    expect(actual).toEqual({
      "notifications.intents.orderCancelled.title": "Order {orderReference} cancelled",
      "notifications.intents.orderCancelled.body.pendingReservation": "You have not been charged.",
      "notifications.intents.orderCancelled.body.paymentDetails": "View your order for any payment or refund details.",
      "notifications.intents.orderCancelled.body.unknown": "View your order for details about this cancellation.",
    });
    for (const value of Object.values(actual)) {
      expect([...value].filter((character) => character.charCodeAt(0) < 32)).toEqual([]);
    }
    expect(t("notifications.intents.orderCancelled.title", { orderReference: "ORD-Q69G5FAV" })).toBe(
      "Order ORD-Q69G5FAV cancelled",
    );
  });
});
