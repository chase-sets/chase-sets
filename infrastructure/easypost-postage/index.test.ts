import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createEasyPostPostageLabelProvider,
  createEasyPostPostageWebhookGateway,
  verifyEasyPostWebhookSignature,
} from ".";

const sampleRequest = {
  shipmentId: "shp_1",
  orderId: "ord_1",
  serviceLevel: "USPS_GROUND_ADVANTAGE",
  sender: {
    name: "Seller",
    street1: "1 Main St",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  },
  recipient: {
    name: "Buyer",
    street1: "2 Market St",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  package: {
    lengthInches: 7,
    widthInches: 5,
    heightInches: 1,
    weightOunces: 4,
  },
};

describe("EasyPost postage adapter", () => {
  it("creates a shipment, buys a USPS rate, and maps label metadata", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/shipments")) {
        return Response.json({
          id: "shp_provider_1",
          mode: "test",
          rates: [
            {
              id: "rate_1",
              carrier: "USPS",
              service: "USPS_GROUND_ADVANTAGE",
              rate: "4.99",
              currency: "USD",
            },
          ],
        });
      }

      return Response.json({
        id: "shp_provider_1",
        mode: "test",
        selected_rate: {
          id: "rate_1",
          carrier: "USPS",
          service: "USPS_GROUND_ADVANTAGE",
          rate: "4.99",
          currency: "USD",
        },
        postage_label: {
          id: "pl_1",
          label_pdf_url: "https://labels.easypost.test/pl_1.pdf",
        },
        tracking_code: "940000000000000000",
      });
    });
    const provider = createEasyPostPostageLabelProvider({
      apiKey: "EZTK_test",
      fetch: fetch as typeof globalThis.fetch,
    });

    const label = await provider.purchaseUspsLabel(sampleRequest);

    expect(label).toMatchObject({
      providerName: "easypost",
      providerMode: "test",
      providerShipmentId: "shp_provider_1",
      providerLabelId: "pl_1",
      providerRateId: "rate_1",
      carrierName: "USPS",
      trackingIdentifier: "940000000000000000",
      postageAmountCents: 499,
    });
  });

  it("voids labels through EasyPost refund requests", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.easypost.com/v2/shipments/shp_provider_1/refund");
      expect(init?.method).toBe("POST");

      return Response.json({
        id: "shp_provider_1",
        mode: "test",
        refund_status: "submitted",
      });
    });
    const provider = createEasyPostPostageLabelProvider({
      apiKey: "EZTK_test",
      fetch: fetch as typeof globalThis.fetch,
    });

    const voided = await provider.voidLabel({
      providerShipmentId: "shp_provider_1",
      providerLabelId: "pl_1",
      trackingIdentifier: "940000000000000000",
    });

    expect(voided).toMatchObject({
      providerName: "easypost",
      providerMode: "test",
      refundReference: "shp_provider_1",
      refundStatus: "submitted",
    });
  });

  it("surfaces EasyPost error messages from failed provider calls", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "Invalid address.",
          },
        },
        { status: 422 },
      ),
    );
    const provider = createEasyPostPostageLabelProvider({
      apiKey: "EZTK_test",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(provider.purchaseUspsLabel(sampleRequest)).rejects.toThrow("Invalid address.");
  });

  it("verifies EasyPost webhook HMAC signatures", () => {
    const rawBody = JSON.stringify({ id: "evt_1" });
    const timestamp = "Tue, 19 Aug 2025 20:37:09 -0000";
    const headers = signedEasyPostHeaders({
      rawBody,
      timestamp,
      path: "/api/fulfillment/provider/postage/webhooks",
      secret: "whsec_test",
    });

    expect(() =>
      verifyEasyPostWebhookSignature({
        rawBody,
        method: "POST",
        path: "/api/fulfillment/provider/postage/webhooks",
        headers,
        webhookSecret: "whsec_test",
        now: () => new Date("2025-08-19T20:37:20.000Z"),
      }),
    ).not.toThrow();
  });

  it("rejects EasyPost webhook signatures outside the tolerance window", () => {
    const rawBody = JSON.stringify({ id: "evt_1" });
    const timestamp = "Tue, 19 Aug 2025 20:37:09 -0000";
    const headers = signedEasyPostHeaders({
      rawBody,
      timestamp,
      path: "/api/fulfillment/provider/postage/webhooks",
      secret: "whsec_test",
    });

    expect(() =>
      verifyEasyPostWebhookSignature({
        rawBody,
        method: "POST",
        path: "/api/fulfillment/provider/postage/webhooks",
        headers,
        webhookSecret: "whsec_test",
        now: () => new Date("2025-08-19T20:39:00.000Z"),
      }),
    ).toThrow("EasyPost webhook timestamp is outside the allowed tolerance.");
  });

  it("normalizes EasyPost tracker webhook events", async () => {
    const rawBody = JSON.stringify({
      id: "evt_tracker_1",
      object: "Event",
      mode: "production",
      description: "tracker.updated",
      created_at: "2026-05-30T12:00:00Z",
      updated_at: "2026-05-30T12:00:01Z",
      result: {
        id: "trk_provider_1",
        object: "Tracker",
        mode: "production",
        tracking_code: "940000000000000000",
        shipment_id: "shp_provider_1",
        status: "delivered",
        status_detail: "arrived_at_destination",
        updated_at: "2026-05-30T12:00:01Z",
      },
    });
    const timestamp = "Sat, 30 May 2026 12:00:02 -0000";
    const gateway = createEasyPostPostageWebhookGateway({
      webhookSecret: "whsec_test",
      now: () => new Date("2026-05-30T12:00:03.000Z"),
    });

    await expect(
      gateway.processPostageProviderWebhook({
        rawBody,
        method: "POST",
        path: "/api/fulfillment/provider/postage/webhooks",
        headers: signedEasyPostHeaders({
          rawBody,
          timestamp,
          path: "/api/fulfillment/provider/postage/webhooks",
          secret: "whsec_test",
        }),
      }),
    ).resolves.toMatchObject({
      providerEventId: "evt_tracker_1",
      providerName: "easypost",
      providerMode: "production",
      eventKind: "tracking-status",
      providerObjectReference: "trk_provider_1",
      providerShipmentId: "shp_provider_1",
      trackingIdentifier: "940000000000000000",
      status: "delivered",
      statusDetail: "arrived_at_destination",
      occurredAt: "2026-05-30T12:00:01Z",
      receivedAt: "2026-05-30T12:00:03.000Z",
    });
  });

  it("normalizes EasyPost refund webhook events with shipment matching fields", async () => {
    const rawBody = JSON.stringify({
      id: "evt_refund_1",
      object: "Event",
      mode: "production",
      description: "refund.successful",
      status: "completed",
      created_at: "2026-05-30T12:00:00Z",
      updated_at: "2026-05-30T12:00:02Z",
      result: {
        id: "rfnd_provider_1",
        object: "Refund",
        mode: "production",
        tracking_code: "940000000000000000",
        shipment_id: "shp_provider_1",
        status: "refunded",
        updated_at: "2026-05-30T12:00:02Z",
      },
    });
    const timestamp = "Sat, 30 May 2026 12:00:03 -0000";
    const gateway = createEasyPostPostageWebhookGateway({
      webhookSecret: "whsec_test",
      now: () => new Date("2026-05-30T12:00:04.000Z"),
    });

    await expect(
      gateway.processPostageProviderWebhook({
        rawBody,
        method: "POST",
        path: "/api/fulfillment/provider/postage/webhooks",
        headers: signedEasyPostHeaders({
          rawBody,
          timestamp,
          path: "/api/fulfillment/provider/postage/webhooks",
          secret: "whsec_test",
        }),
      }),
    ).resolves.toMatchObject({
      providerEventId: "evt_refund_1",
      providerName: "easypost",
      providerMode: "production",
      eventKind: "refund-status",
      providerObjectReference: "rfnd_provider_1",
      providerShipmentId: "shp_provider_1",
      trackingIdentifier: "940000000000000000",
      status: "refunded",
      occurredAt: "2026-05-30T12:00:02Z",
      receivedAt: "2026-05-30T12:00:04.000Z",
    });
  });
});

function signedEasyPostHeaders(input: Readonly<{ rawBody: string; timestamp: string; path: string; secret: string }>) {
  const signedPayload = `${input.timestamp}POST${input.path}${input.rawBody}`;
  const signature = createHmac("sha256", input.secret).update(signedPayload, "utf8").digest("hex");

  return new Headers({
    "x-timestamp": input.timestamp,
    "x-path": input.path,
    "x-hmac-signature-v2": `hmac-sha256-hex=${signature}`,
  });
}
