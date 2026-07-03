import { describe, expect, it } from "vitest";
import { createSandboxPostageLabelProvider } from "./test-support";

describe("sandbox postage label adapter", () => {
  it("creates deterministic test USPS metadata", async () => {
    const provider = createSandboxPostageLabelProvider();

    const label = await provider.purchaseUspsLabel({
      shipmentId: "shp_test_123",
      orderId: "ord_1",
      idempotencyKey: "shipment:shp_test_123:purchase-usps-label:initial",
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
        mailpieceClass: "letter",
        lengthInches: 7,
        widthInches: 5,
        heightInches: 1,
        weightOunces: 4,
      },
    });

    expect(label.providerName).toBe("sandbox-usps");
    expect(label.carrierName).toBe("USPS");
    expect(label.labelDocumentUrl).toContain("shp_test_123");
  });
});
