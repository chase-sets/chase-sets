import { describe, expect, it } from "vitest";
import {
  walletAdjustmentAccountDirectionLabel,
  walletAdjustmentAccountDirectionTone,
  walletAdjustmentAccountStatusLabel,
  walletAdjustmentAccountStatusTone,
  type WalletAdjustmentAccountStatus,
} from "./wallet-adjustment-account-copy";

const STATUSES: readonly WalletAdjustmentAccountStatus[] = ["requested", "approved", "rejected", "posted", "reversed"];

describe("wallet adjustment account copy", () => {
  it("gives every account-facing status a non-empty label without a missing-translation marker", () => {
    for (const status of STATUSES) {
      const label = walletAdjustmentAccountStatusLabel(status);
      expect(label).not.toMatch(/^\[missing:/);
      expect(label.length).toBeGreaterThan(0);
      expect(walletAdjustmentAccountStatusTone(status)).toBeTruthy();
    }
  });

  it("gives every direction a distinct, non-empty label and tone", () => {
    expect(walletAdjustmentAccountDirectionLabel("credit")).not.toBe(walletAdjustmentAccountDirectionLabel("debit"));
    expect(walletAdjustmentAccountDirectionTone("credit")).toBe("success");
    expect(walletAdjustmentAccountDirectionTone("debit")).toBe("danger");
  });
});
