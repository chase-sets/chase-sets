import { describe, expect, it } from "vitest";
import { defaultNotificationPreferences } from "../features/preferences/domain/preferences";

describe("notification preferences", () => {
  it("keeps product alerts as a notification setting category", () => {
    expect(defaultNotificationPreferences.map((preference) => preference.key)).toEqual([
      "web",
      "email",
      "product-alerts",
    ]);
  });
});
