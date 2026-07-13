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

  it("classifies the elevated-approval domain conflict by message text", () => {
    const result = describeWalletAdjustmentFlowError(
      apiError(409, {
        error: { code: "conflict", message: "This Wallet Adjustment requires a second, elevated approval." },
      }),
      "fallback",
    );
    expect(result.kind).toBe("requires-elevated-approval");
  });

  it("classifies the self-benefiting domain conflict by message text", () => {
    const result = describeWalletAdjustmentFlowError(
      apiError(409, {
        error: {
          code: "conflict",
          message: "A self-benefiting Wallet Adjustment is blocked outright and cannot be approved.",
        },
      }),
      "fallback",
    );
    expect(result.kind).toBe("self-benefiting-blocked");
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
