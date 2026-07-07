import type { PostageLabelProvider } from "./index";

export function createSandboxPostageLabelProvider(): PostageLabelProvider {
  return {
    providerName: "sandbox-usps",
    providerMode: "test",
    async verifyAddress(request) {
      return {
        providerName: "sandbox-usps",
        providerMode: "test",
        status: "verified",
        checkedAt: new Date().toISOString(),
        address: request.address,
        suggestedAddress: null,
        messages: [],
      };
    },
    async purchaseUspsLabel(request) {
      const suffix = request.idempotencyKey.replace(/[^a-zA-Z0-9]/g, "").slice(-10) || "TEST";
      return {
        providerName: "sandbox-usps",
        providerMode: "test",
        providerShipmentId: `sandbox_shipment_${suffix}`,
        providerLabelId: `sandbox_label_${suffix}`,
        providerRateId: `sandbox_rate_${request.serviceLevel}`,
        carrierName: "USPS",
        serviceLevel: request.serviceLevel,
        labelReference: `sandbox_label_${suffix}`,
        labelDocumentUrl: `https://sandbox.chasesets.test/labels/${request.shipmentId}.pdf`,
        trackingIdentifier: `9400${suffix.padStart(18, "0").slice(0, 18)}`,
        postageAmountCents: 499,
        postageCurrency: "USD",
        purchasedAt: new Date().toISOString(),
      };
    },
    async voidLabel(request) {
      return {
        providerName: "sandbox-usps",
        providerMode: "test",
        refundReference: `sandbox_refund_${request.providerLabelId}`,
        refundStatus: "submitted",
        voidedAt: new Date().toISOString(),
      };
    },
  };
}
