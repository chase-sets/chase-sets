import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NotificationMessage } from "@chase-sets/notifications";
import { createTwilioMessagingAdapter, parseTwilioMessagingWebhook } from "./index";

const message: NotificationMessage = {
  messageType: "fulfillment.shipment.exception",
  criticality: "operational",
  title: "Shipment needs attention",
  body: "Shipment shp_1 needs attention.",
  actionHref: "/account/shipments/shp_1",
  templateId: "shipment_exception",
  templateVersion: 1,
  locale: "en",
  templateData: { shipmentId: "shp_1" },
  channels: [
    {
      channel: "rcs",
      to: { e164: "+15551234567" },
      title: "Shipment needs attention",
      body: "Shipment shp_1 needs attention.",
      smsFallback: {
        to: { e164: "+15551234567" },
        body: "Shipment shp_1 needs attention.",
      },
    },
  ],
  idempotencyKey: "notifications:fulfillment:shipment_exception:shp_1",
  correlationId: "req_1",
  actor: { userId: null, accountId: "acc_buyer" as never },
};

describe("twilio messaging adapter", () => {
  it("sends RCS deliveries through Twilio Programmable Messaging", async () => {
    const sendRequest = vi.fn(async (_request: { url: string; body: URLSearchParams }) => ({
      sid: "SM123",
      status: "queued",
    }));
    const adapter = createTwilioMessagingAdapter({
      accountSid: "AC123",
      authToken: "secret",
      messagingServiceSid: "MG123",
      channel: "rcs",
      apiBaseUrl: "https://twilio.test",
      statusCallbackBaseUrl: "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks",
      sendRequest,
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    });

    const receipt = await adapter.sendNotificationChannel({
      deliveryId: "delivery_1",
      message,
      channel: message.channels[0],
    });

    expect(receipt).toEqual({
      channel: "rcs",
      providerName: "twilio",
      providerMessageId: "SM123",
      acceptedAt: "2026-05-15T12:00:00.000Z",
      attemptCount: 1,
    });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    const request = sendRequest.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://twilio.test/2010-04-01/Accounts/AC123/Messages.json");
    expect(request?.body.get("To")).toBe("+15551234567");
    expect(request?.body.get("MessagingServiceSid")).toBe("MG123");
    expect(request?.body.get("Body")).toBe("Shipment shp_1 needs attention.");
    expect(request?.body.get("StatusCallback")).toBe(
      "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks?deliveryId=delivery_1",
    );
  });

  it("parses signed delivery status callbacks", () => {
    const url = "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks?deliveryId=delivery_1";
    const body = new URLSearchParams({
      MessageSid: "SM123",
      MessageStatus: "delivered",
      To: "+15551234567",
      From: "+15557654321",
    }).toString();

    expect(
      parseTwilioMessagingWebhook({
        rawBody: body,
        url,
        signatureHeader: signTwilio(url, body, "secret"),
        authToken: "secret",
        receivedAt: "2026-05-15T12:01:00.000Z",
      }),
    ).toEqual({
      providerEventId: "twilio:SM123:delivery-status:delivered",
      providerName: "twilio",
      eventKind: "delivery-status",
      providerMessageId: "SM123",
      deliveryId: "delivery_1",
      status: "delivered",
      failureCode: null,
      failureMessage: null,
      fromPhoneNumber: "+15557654321",
      toPhoneNumber: "+15551234567",
      body: null,
      occurredAt: "2026-05-15T12:01:00.000Z",
      receivedAt: "2026-05-15T12:01:00.000Z",
    });
  });

  it("parses signed inbound replies as SMS/RCS interactions", () => {
    const url = "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks";
    const body = new URLSearchParams({
      MessageSid: "SM456",
      To: "+15557654321",
      From: "+15551234567",
      Body: "HELP",
    }).toString();

    expect(
      parseTwilioMessagingWebhook({
        rawBody: body,
        url,
        signatureHeader: signTwilio(url, body, "secret"),
        authToken: "secret",
        receivedAt: "2026-05-15T12:02:00.000Z",
      }),
    ).toMatchObject({
      providerEventId: "twilio:SM456:inbound-message:received",
      eventKind: "inbound-message",
      providerMessageId: "SM456",
      status: "received",
      fromPhoneNumber: "+15551234567",
      toPhoneNumber: "+15557654321",
      body: "HELP",
    });
  });

  it("rejects callbacks with invalid signatures", () => {
    expect(() =>
      parseTwilioMessagingWebhook({
        rawBody: "MessageSid=SM123&MessageStatus=failed",
        url: "https://api.chasesets.test/api/notifications/provider/mobile-messaging/webhooks",
        signatureHeader: "bad",
        authToken: "secret",
      }),
    ).toThrow("Twilio webhook signature verification failed.");
  });
});

function signTwilio(url: string, rawBody: string, authToken: string) {
  const params = new URLSearchParams(rawBody);
  const payload = `${url}${[...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join("")}`;

  return createHmac("sha1", authToken).update(payload).digest("base64");
}
