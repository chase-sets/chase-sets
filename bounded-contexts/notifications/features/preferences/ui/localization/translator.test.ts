import { describe, expect, it } from "vitest";
import { getNotificationPreferenceCopy, invalidNotificationPreferenceMessage } from "./translator";

describe("notification preference localization", () => {
  it("resolves the labels and descriptions for all supported preference keys", () => {
    expect(getNotificationPreferenceCopy("web")).toEqual({
      label: "In-app notifications",
      description: "Show marketplace updates in the notification center.",
    });
    expect(getNotificationPreferenceCopy("email")).toEqual({
      label: "Email notifications",
      description: "Allow email delivery for eligible marketplace updates.",
    });
    expect(getNotificationPreferenceCopy("product-alerts")).toEqual({
      label: "Product alerts",
      description: "Notify this account when watched products match alert rules.",
    });
  });

  it("preserves the invalid preference response copy", () => {
    expect(invalidNotificationPreferenceMessage()).toBe("Notification preference is not supported.");
  });
});
