import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEasyPostPostageLabelProvider } from ".";
import { easyPostTestMemberParcel, easyPostTestRecipient, easyPostTestSender } from "./tests/easypost-test-fixtures";

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
      subjectKind: "shipment",
      subjectId: `smoke-${Date.now()}`,
      idempotencyKey: `smoke:${Date.now()}:purchase-usps-label:initial`,
      serviceLevel: "GroundAdvantage",
      sender: easyPostTestSender,
      recipient: easyPostTestRecipient,
      package: easyPostTestMemberParcel,
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
