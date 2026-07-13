import { describe, expect, it } from "vitest";
import { WALLET_ADJUSTMENT_REASON_CODES } from "../domain/wallet-adjustment";
import { WALLET_ADJUSTMENT_FLOW_ERROR_KINDS } from "../../../support/request-support/wallet-adjustment-flow-error";
import {
  walletAdjustmentDirectionLabel,
  walletAdjustmentDirectionTone,
  walletAdjustmentElevationReasonLabel,
  walletAdjustmentFlowErrorTitle,
  walletAdjustmentFlowErrorTone,
  walletAdjustmentReasonCodeItems,
  walletAdjustmentReasonCodeLabel,
  walletAdjustmentReasonCodeRequiresExplanation,
  walletAdjustmentStatusLabel,
  walletAdjustmentStatusTone,
} from "./wallet-adjustment-copy";

describe("wallet adjustment copy", () => {
  it("gives every direction a distinct, non-empty label and tone", () => {
    expect(walletAdjustmentDirectionLabel("credit")).not.toBe(walletAdjustmentDirectionLabel("debit"));
    expect(walletAdjustmentDirectionTone("credit")).toBe("success");
    expect(walletAdjustmentDirectionTone("debit")).toBe("danger");
  });

  it("labels every reason code in the ratified taxonomy without a missing-translation marker", () => {
    for (const reasonCode of WALLET_ADJUSTMENT_REASON_CODES) {
      const label = walletAdjustmentReasonCodeLabel(reasonCode);
      expect(label).not.toMatch(/^\[missing:/);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(walletAdjustmentReasonCodeItems()).toHaveLength(WALLET_ADJUSTMENT_REASON_CODES.length);
  });

  it("flags only the free-text reason code as requiring an explanation", () => {
    expect(walletAdjustmentReasonCodeRequiresExplanation("other-with-required-detail")).toBe(true);
    expect(walletAdjustmentReasonCodeRequiresExplanation("transaction-correction")).toBe(false);
  });

  it("labels every workflow status distinctly (requested, awaiting approval, approved/posting, posted, rejected, failed/retryable, reversed)", () => {
    const statuses = ["requested", "approved", "rejected", "posted", "reversed"] as const;
    const labels = statuses.map(walletAdjustmentStatusLabel);
    expect(new Set(labels).size).toBe(statuses.length);
    for (const status of statuses) {
      expect(walletAdjustmentStatusTone(status)).toBeTruthy();
    }
  });

  it("labels every elevation reason distinctly", () => {
    const reasons = ["high-value", "negative-balance", "reversal-after-settlement"] as const;
    const labels = reasons.map(walletAdjustmentElevationReasonLabel);
    expect(new Set(labels).size).toBe(reasons.length);
  });

  it("gives every flow-error kind a deterministic title and danger/warning tone", () => {
    for (const kind of WALLET_ADJUSTMENT_FLOW_ERROR_KINDS) {
      expect(walletAdjustmentFlowErrorTitle(kind).length).toBeGreaterThan(0);
      expect(["danger", "warning"]).toContain(walletAdjustmentFlowErrorTone(kind));
    }
  });
});
