import { describe, expect, it } from "vitest";
import { readWalletAdjustmentGuidedFlowValues } from "./wallet-adjustment-guided-flow-form-data";

function formData(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        data.append(key, item);
      }
    } else {
      data.set(key, value);
    }
  }
  return data;
}

describe("readWalletAdjustmentGuidedFlowValues", () => {
  it("reads a complete, valid submission", () => {
    const values = readWalletAdjustmentGuidedFlowValues(
      formData({
        direction: "debit",
        amount: "10.00",
        reasonCode: "operational-error",
        explanation: "typo",
        evidenceReferences: ["ord_1", "ord_2"],
      }),
    );

    expect(values).toEqual({
      direction: "debit",
      amount: "10.00",
      reasonCode: "operational-error",
      explanation: "typo",
      evidenceReferences: ["ord_1", "ord_2"],
    });
  });

  it("defaults direction to credit for any value other than 'debit'", () => {
    expect(readWalletAdjustmentGuidedFlowValues(formData({ direction: "bogus" })).direction).toBe("credit");
    expect(readWalletAdjustmentGuidedFlowValues(formData({})).direction).toBe("credit");
  });

  it("falls back to transaction-correction for an unrecognized reason code", () => {
    expect(readWalletAdjustmentGuidedFlowValues(formData({ reasonCode: "not-a-real-code" })).reasonCode).toBe(
      "transaction-correction",
    );
  });

  it("drops blank evidence references", () => {
    const values = readWalletAdjustmentGuidedFlowValues(formData({ evidenceReferences: ["ord_1", "", "  "] }));
    expect(values.evidenceReferences).toEqual(["ord_1"]);
  });
});
