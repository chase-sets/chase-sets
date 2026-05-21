import { describe, expect, it, vi } from "vitest";
import { createEasyPostPostageLabelProvider } from ".";

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
});
