import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEasyPostPostageLabelProvider } from ".";

const easyPostApiKey = process.env.EASYPOST_API_KEY;
const canRunEasyPostSmoke = easyPostApiKey?.startsWith("EZTK");
const describeWithEasyPostTestKey = canRunEasyPostSmoke ? describe : describe.skip;
const sandboxEvidencePath = process.env.EASYPOST_SANDBOX_EVIDENCE_PATH;

describeWithEasyPostTestKey("EasyPost USPS sandbox smoke", () => {
  it("purchases and voids a USPS test label with an EasyPost test key", async () => {
    const provider = createEasyPostPostageLabelProvider({
      apiKey: easyPostApiKey!,
      mode: "test",
    });

    const label = await provider.purchaseUspsLabel({
      shipmentId: `smoke-${Date.now()}`,
      orderId: `order-${Date.now()}`,
      serviceLevel: "GroundAdvantage",
      sender: {
        name: "Chase Sets Seller",
        street1: "417 Montgomery St",
        city: "San Francisco",
        state: "CA",
        postalCode: "94104",
        country: "US",
        phone: "4155550100",
        email: "seller@example.com",
      },
      recipient: {
        name: "Chase Sets Buyer",
        street1: "388 Townsend St",
        city: "San Francisco",
        state: "CA",
        postalCode: "94107",
        country: "US",
        phone: "4155550101",
        email: "buyer@example.com",
      },
      package: {
        lengthInches: 7,
        widthInches: 5,
        heightInches: 1,
        weightOunces: 4,
      },
    });

    expect(label.providerName).toBe("easypost");
    expect(label.providerMode).toBe("test");
    expect(label.carrierName).toBe("USPS");
    expect(label.labelDocumentUrl).toContain("http");
    expect(label.trackingIdentifier).toBeTruthy();

    const voided = await provider.voidLabel({
      providerShipmentId: label.providerShipmentId,
      providerLabelId: label.providerLabelId,
      trackingIdentifier: label.trackingIdentifier,
    });

    expect(voided.providerName).toBe("easypost");
    expect(voided.providerMode).toBe("test");
    expect(voided.refundReference).toBeTruthy();
    expect(voided.refundStatus).toBeTruthy();

    await writeSandboxEvidence({
      verifiedAt: new Date().toISOString(),
      providerShipmentId: label.providerShipmentId,
      providerLabelId: label.providerLabelId,
      providerRateId: label.providerRateId,
      trackingIdentifier: label.trackingIdentifier,
      serviceLevel: label.serviceLevel ?? "USPS",
      postageAmountCents: label.postageAmountCents,
      postageCurrency: label.postageCurrency,
      refundReference: voided.refundReference!,
      refundStatus: voided.refundStatus!,
    });
  });
});

async function writeSandboxEvidence(
  evidence: Readonly<{
    verifiedAt: string;
    providerShipmentId: string;
    providerLabelId: string;
    providerRateId?: string | null;
    trackingIdentifier: string;
    serviceLevel: string;
    postageAmountCents?: number | null;
    postageCurrency?: string | null;
    refundReference: string;
    refundStatus: string;
  }>,
) {
  if (!sandboxEvidencePath) {
    return;
  }

  await mkdir(dirname(sandboxEvidencePath), { recursive: true });
  await writeFile(
    sandboxEvidencePath,
    `${JSON.stringify(
      {
        schemaVersion: "easypost-sandbox-smoke-evidence/v1",
        label: "sandbox verified but not completed",
        sandboxVerified: true,
        productionCompleted: false,
        environment: "test",
        providerName: "easypost",
        providerMode: "test",
        ...evidence,
      },
      null,
      2,
    )}\n`,
  );
}
