import { describe, expect, it } from "vitest";
import { createSupportResponsibilityFact, normalizeSupportResolutionForReplay } from "./responsibility";

describe("support resolution responsibility", () => {
  it.each([
    ["seller", "product-not-as-described", "product-not-as-described.seller-misdescription"],
    ["buyer", "return-request", "return-request.buyer-remorse"],
    ["carrier", "product-not-received", "product-not-received.carrier-loss"],
    ["platform", "payment-problem", "payment-problem.platform-payment-processing-error"],
    ["shared", "product-damaged", "product-damaged.shared-packaging-and-handling"],
  ] as const)("validates %s responsibility independently from remedy", (responsibility, flowType, reasonCode) => {
    expect(
      createSupportResponsibilityFact({
        flowType,
        responsibility,
        evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
        responsibilityReasonCode: reasonCode,
      }),
    ).toMatchObject({ responsibility, responsibilityReasonCode: reasonCode });
  });

  it("represents conflicting evidence as undetermined without inventing responsibility", () => {
    expect(
      createSupportResponsibilityFact({
        flowType: "product-damaged",
        responsibility: "undetermined",
        evidenceBasis: { type: "insufficient-evidence", reference: "support-test.conflicting-evidence.v1" },
        responsibilityReasonCode: "product-damaged.conflicting-evidence",
      }),
    ).toEqual({
      responsibility: "undetermined",
      evidenceBasis: { type: "insufficient-evidence", reference: "support-test.conflicting-evidence.v1" },
      responsibilityReasonCode: "product-damaged.conflicting-evidence",
    });
  });

  it("rejects internally inconsistent responsibility facts", () => {
    expect(() =>
      createSupportResponsibilityFact({
        flowType: "product-not-as-described",
        responsibility: "seller",
        evidenceBasis: { type: "insufficient-evidence", reference: "support-test.conflicting-evidence.v1" },
        responsibilityReasonCode: "product-not-as-described.seller-misdescription",
      }),
    ).toThrow("Insufficient evidence can only produce undetermined responsibility.");

    expect(() =>
      createSupportResponsibilityFact({
        flowType: "product-not-received",
        responsibility: "carrier",
        evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
        responsibilityReasonCode: "product-not-received.seller-did-not-ship",
      }),
    ).toThrow("Support responsibility does not match its reason code.");

    expect(() =>
      createSupportResponsibilityFact({
        flowType: "return-request",
        responsibility: "seller",
        evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
        responsibilityReasonCode: "product-not-as-described.seller-misdescription",
      }),
    ).toThrow("Support responsibility reason is not supported for this flow.");
  });

  it("upcasts a pre-change resolution to explicit legacy and undetermined facts", () => {
    const resolution = normalizeSupportResolutionForReplay(
      {
        resolutionType: "full-refund",
        summary: "Historical refund.",
        refundAmount: "25.00",
        resolvedByAccountId: null,
        resolvedByRole: null,
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
      "product-not-received",
    );

    expect(resolution).toMatchObject({
      resolutionType: "full-refund",
      responsibility: "undetermined",
      evidenceBasis: { type: "legacy", reference: "support-event.pre-responsibility-resolution.v1" },
      responsibilityReasonCode: "product-not-received.legacy-resolution-without-responsibility",
    });
  });
});
