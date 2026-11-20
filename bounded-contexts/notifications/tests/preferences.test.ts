import { applyNotificationChannelPreferences, type NotificationMessage } from "@chase-sets/outbound-messaging";
import { describe, expect, it } from "vitest";
import {
  defaultNotificationPreferences,
  deliveryChannelPreferences,
  isNotificationPreferenceKey,
} from "../features/preferences/domain/preferences";

function message(overrides: Partial<NotificationMessage>): NotificationMessage {
  return {
    messageType: "test.message",
    criticality: "operational",
    title: "Title",
    body: "Body",
    templateId: "test",
    templateVersion: 1,
    locale: "en",
    templateData: {},
    channels: [{ channel: "sms", to: { e164: "+15555550100" }, body: "Body" }],
    idempotencyKey: "test",
    correlationId: "test",
    actor: { userId: null, accountId: null },
    ...overrides,
  } as NotificationMessage;
}

describe("notification preferences", () => {
  it("offers only the settings the platform has words and delivery for", () => {
    expect(defaultNotificationPreferences.map((preference) => preference.key)).toEqual([
      "web",
      "email",
      "product-alerts",
    ]);
    expect(isNotificationPreferenceKey("email")).toBe(true);
    expect(isNotificationPreferenceKey("sms")).toBe(false);
    expect(isNotificationPreferenceKey("rcs")).toBe(false);
  });

  it("keeps SMS and RCS off for delivery while they have no setting", () => {
    expect(deliveryChannelPreferences(defaultNotificationPreferences)).toEqual([
      { channel: "web", enabled: true },
      { channel: "email", enabled: true },
      { channel: null, category: "product-alerts", enabled: true },
      { channel: "sms", enabled: false },
      { channel: "rcs", enabled: false },
    ]);
  });

  it("still sends a sign-in code by SMS, which no preference can stop", () => {
    const preferences = deliveryChannelPreferences(defaultNotificationPreferences);

    expect(applyNotificationChannelPreferences(message({ criticality: "security" }), preferences)).not.toBeNull();
    expect(applyNotificationChannelPreferences(message({}), preferences)).toBeNull();
  });
});
