import { describe, expect, it } from "vitest";
import { defaultNotificationPreferences } from "../features/preferences/domain/preferences";

describe("notification preferences", () => {
  it("keeps product alerts as a notification setting category", () => {
    expect(defaultNotificationPreferences.map((preference) => preference.key)).toEqual([
      "web",
      "email",
      "sms",
      "rcs",
      "product-alerts",
    ]);
    expect(
      defaultNotificationPreferences.find(
        (preference) => preference.key === "sms",
      )?.enabled,
    ).toBe(false);
    expect(
      defaultNotificationPreferences.find(
        (preference) => preference.key === "rcs",
      )?.enabled,
    ).toBe(false);
  });
});
