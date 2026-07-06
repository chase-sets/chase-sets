import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostageLabelProviderError } from "@chase-sets/postage-labels";
import {
  createEasyPostPostageLabelProvider,
  createEasyPostPostageWebhookGateway,
  verifyEasyPostWebhookSignature,
} from ".";

const sampleRequest = {
  shipmentId: "shp_1",
  orderId: "ord_1",
  idempotencyKey: "shipment:shp_1:purchase-usps-label:initial",
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
  it("creates a parcel shipment, buys a USPS rate, and maps label metadata", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/shipments")) {
        const body = JSON.parse(String(init?.body));
        expect(body.shipment.reference).toBe("shipment:shp_1:purchase-usps-label:initial");
        expect(body.shipment.parcel).toMatchObject({
          length: 7,
          width: 5,
          height: 1,
          weight: 4,
        });
        expect(body.shipment.parcel).not.toHaveProperty("predefined_package");
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

  it("requests signature confirmation and insurance on EasyPost shipment options", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/shipments")) {
        const body = JSON.parse(String(init?.body));
        expect(body.shipment.options).toMatchObject({
          label_format: "PDF",
          delivery_confirmation: "SIGNATURE",
          insurance: "500.00",
        });
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
        tracker: { id: "trk_1" },
        tracking_code: "940000000000000000",
      });
    });
    const provider = createEasyPostPostageLabelProvider({
      apiKey: "EZTK_test",
      fetch: fetch as typeof globalThis.fetch,
    });

    await provider.purchaseUspsLabel({
      ...sampleRequest,
      deliveryConfirmation: "signature",
      insuranceAmount: "500.00",
    });
  });

  it("passes Letter Mail package and label-size intent to EasyPost", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/shipments")) {
        const body = JSON.parse(String(init?.body));
        expect(body.shipment.parcel).toMatchObject({
          predefined_package: "Letter",
          length: 9.5,
          width: 4.125,
          height: 0.25,
          weight: 0.47,
        });
        expect(body.shipment.options).toMatchObject({
          label_format: "PDF",
          label_size: "7x3",
        });
        return Response.json({
          id: "shp_provider_letter_1",
          mode: "test",
          rates: [
            {
              id: "rate_letter_1",
              carrier: "USPS",
              service: "First",
              rate: "0.73",
              currency: "USD",
            },
          ],
        });
      }

      return Response.json({
        id: "shp_provider_letter_1",
        mode: "test",
        selected_rate: {
          id: "rate_letter_1",
          carrier: "USPS",
          service: "First",
          rate: "0.73",
          currency: "USD",
        },
        postage_label: {
          id: "pl_letter_1",
          label_pdf_url: "https://labels.easypost.test/pl_letter_1.pdf",
        },
        tracking_code: "940000000000000001",
      });
    });
    const provider = createEasyPostPostageLabelProvider({
      apiKey: "EZTK_test",
      fetch: fetch as typeof globalThis.fetch,
    });

    const label = await provider.purchaseUspsLabel({
      ...sampleRequest,
      serviceLevel: "First",
      labelSize: "7x3",
      package: {
        mailpieceClass: "letter",
        lengthInches: 9.5,
        widthInches: 4.125,
        heightInches: 0.25,
        weightOunces: 0.47,
      },
    });

    expect(label).toMatchObject({
      serviceLevel: "First",
      postageAmountCents: 73,
      providerLabelId: "pl_letter_1",
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

  it("recovers an already-purchased shipment by the operation reference", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.easypost.com/v2/shipments/shipment%3Ashp_1%3Apurchase-usps-label%3Ainitial",
      );
      expect(init?.method).toBe("GET");

      return Response.json({
        id: "shp_provider_1",
        mode: "test",
        reference: "shipment:shp_1:purchase-usps-label:initial",
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

    const label = await provider.recoverPurchasedUspsLabel?.({
      idempotencyKey: "shipment:shp_1:purchase-usps-label:initial",
    });

    expect(label).toMatchObject({
      providerShipmentId: "shp_provider_1",
      providerLabelId: "pl_1",
      trackingIdentifier: "940000000000000000",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("fails closed when EasyPost cannot provide the requested USPS service level", async () => {
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
              service: "MEDIA_MAIL",
              rate: "4.99",
              currency: "USD",
            },
          ],
        });
      }

      throw new Error("Buy should not be called when the requested service is unavailable.");
    });
    const provider = createEasyPostPostageLabelProvider({
      apiKey: "EZTK_test",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(provider.purchaseUspsLabel(sampleRequest)).rejects.toMatchObject({
      name: "postage_provider_capability_failure",
      kind: "capability",
      capability: "usps-service-level",
      providerName: "easypost",
      providerMode: "test",
    } satisfies Partial<PostageLabelProviderError>);
    expect(fetch).toHaveBeenCalledTimes(1);
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
