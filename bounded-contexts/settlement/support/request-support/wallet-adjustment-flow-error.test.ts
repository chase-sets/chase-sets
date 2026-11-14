import { describe, expect, it } from "vitest";
import { SettlementApiError } from "../../client";
import { describeWalletAdjustmentFlowError } from "./wallet-adjustment-flow-error";

function apiError(status: number, body: unknown) {
  return new SettlementApiError(status, body);
}

describe("describeWalletAdjustmentFlowError", () => {
  it("classifies step-up-required from the machine-coded error code", () => {
    const result = describeWalletAdjustmentFlowError(
      apiError(401, { error: { code: "step_up_required", message: "Confirm it is you." } }),
      "fallback",
    );
    expect(result).toEqual({ kind: "step-up-required", message: "Confirm it is you.", fieldErrors: [] });
  });

  it("classifies a stale-balance conflict as stale-preview", () => {
    const result = describeWalletAdjustmentFlowError(
      apiError(409, {
        error: {
          code: "conflict",
          message: "Wallet balance changed since preview; re-preview before confirming this adjustment.",
          details: [{ code: "stale_balance_revision", message: "stale" }],
        },
      }),
      "fallback",
    );
    expect(result.kind).toBe("stale-preview");
  });

  it.each([
    { detailCode: "elevated_approval_required", kind: "requires-elevated-approval" },
    { detailCode: "self_benefiting_blocked", kind: "self-benefiting-blocked" },
  ])("classifies the $detailCode approval refusal by its detail code, whatever the message says", (refusal) => {
    const message = "Reworded refusal copy that names neither cause.";
    const result = describeWalletAdjustmentFlowError(
      apiError(409, { error: { code: "conflict", message, details: [{ code: refusal.detailCode, message }] } }),
      "fallback",
    );
    expect(result.kind).toBe(refusal.kind);
    expect(result.message).toBe(message);
  });

  it.each([
    "This Wallet Adjustment requires a second, elevated approval.",
    "A self-benefiting Wallet Adjustment is blocked outright and cannot be approved.",
    "A Wallet Adjustment cannot be approved by its requester.",
  ])("keeps a conflict without a refusal detail code generic even when its message is %j", (message) => {
    const withoutDetails = describeWalletAdjustmentFlowError(
      apiError(409, { error: { code: "conflict", message } }),
      "fallback",
    );
    const withUnknownDetail = describeWalletAdjustmentFlowError(
      apiError(409, { error: { code: "conflict", message, details: [{ code: "some_other_refusal", message }] } }),
      "fallback",
    );
    expect(withoutDetails.kind).toBe("conflict");
    expect(withUnknownDetail.kind).toBe("conflict");
  });

  it("classifies validation failures and preserves field errors", () => {
    const result = describeWalletAdjustmentFlowError(
      apiError(400, {
        error: {
          code: "validation_failed",
          message: "Amount must be a positive money value.",
          details: [{ field: "amount", code: "invalid_amount", message: "Amount must be a positive money value." }],
        },
      }),
      "fallback",
    );
    expect(result.kind).toBe("validation");
    expect(result.fieldErrors).toEqual([
      { fieldId: "amount", fieldName: "amount", message: "Amount must be a positive money value." },
    ]);
  });

  it("classifies not-found, forbidden, and authentication-required by code", () => {
    expect(
      describeWalletAdjustmentFlowError(apiError(404, { error: { code: "not_found", message: "x" } }), "f").kind,
    ).toBe("not-found");
    expect(
      describeWalletAdjustmentFlowError(
        apiError(403, { error: { code: "authorization_forbidden", message: "x" } }),
        "f",
      ).kind,
    ).toBe("forbidden");
    expect(
      describeWalletAdjustmentFlowError(
        apiError(401, { error: { code: "authentication_required", message: "x" } }),
        "f",
      ).kind,
    ).toBe("authentication-required");
  });

  it("falls back to unknown for a non-API error", () => {
    const result = describeWalletAdjustmentFlowError(new Error("boom"), "fallback");
    expect(result).toEqual({ kind: "unknown", message: "boom", fieldErrors: [] });
  });

  it("falls back to unknown for a completely opaque throw", () => {
    const result = describeWalletAdjustmentFlowError("nope", "fallback");
    expect(result).toEqual({ kind: "unknown", message: "fallback", fieldErrors: [] });
  });
});
