import { describe, expect, it } from "vitest";
import type { PostageLabelProvider } from ".";

describe("postage label provider contract", () => {
  it("keeps USPS purchase and void capabilities behind one port", () => {
    const provider = {
      providerName: "contract-test",
      providerMode: "test",
      purchaseUspsLabel: async () => ({
        providerName: "contract-test",
        providerMode: "test",
        providerShipmentId: "provider_shipment_1",
        providerLabelId: "provider_label_1",
        providerRateId: "provider_rate_1",
        carrierName: "USPS",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        labelReference: "provider_label_1",
        labelDocumentUrl: "https://labels.test/label.pdf",
        trackingIdentifier: "940000000000000000",
        postageAmountCents: 499,
        postageCurrency: "USD",
        purchasedAt: "2026-04-02T00:00:00.000Z",
      }),
      voidLabel: async () => ({
        providerName: "contract-test",
        providerMode: "test",
        refundReference: "refund_1",
        refundStatus: "submitted",
        voidedAt: "2026-04-02T00:10:00.000Z",
      }),
    } satisfies PostageLabelProvider;

    expect(provider.providerName).toBe("contract-test");
  });
});
