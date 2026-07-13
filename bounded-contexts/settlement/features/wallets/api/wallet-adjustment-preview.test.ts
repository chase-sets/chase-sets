import { describe, expect, it } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { initialWalletState, type WalletState } from "../domain/domain";
import { buildWalletAdjustmentPreview, computeWalletBalanceRevision } from "./wallet-adjustment-preview";

function walletState(overrides: Partial<WalletState>): WalletState {
  return {
    ...initialWalletState,
    accountId: "acc_target" as AccountId,
    currencyCode: "usd",
    ...overrides,
  };
}

describe("buildWalletAdjustmentPreview", () => {
  it("projects a credit as spendable, payoutable, cash-equivalent, and ordinary", () => {
    const preview = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "10.00" }), {
      direction: "credit",
      amount: "5.00",
      currencyCode: "usd",
      reasonCode: "goodwill-cash-credit",
      selfBenefiting: false,
      reversalAfterFundsSettled: false,
    });

    expect(preview.available_balance_before).toBe("10.00");
    expect(preview.available_balance_after).toBe("15.00");
    expect(preview.cash_equivalent).toBe(true);
    expect(preview.spendable).toBe(true);
    expect(preview.payoutable).toBe(true);
    expect(preview.creates_or_increases_negative_balance).toBe(false);
    expect(preview.requires_second_approval).toBe(false);
    expect(preview.blocked_reason).toBeNull();
  });

  it("flags a debit that drives the balance negative as elevated", () => {
    const preview = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "10.00" }), {
      direction: "debit",
      amount: "25.00",
      currencyCode: "usd",
      reasonCode: "operational-error",
      selfBenefiting: false,
      reversalAfterFundsSettled: false,
    });

    expect(preview.available_balance_after).toBe("-15.00");
    expect(preview.creates_or_increases_negative_balance).toBe(true);
    expect(preview.spendable).toBe(false);
    expect(preview.payoutable).toBe(false);
    expect(preview.requires_second_approval).toBe(true);
    expect(preview.elevation_reasons).toContain("negative-balance");
  });

  it("flags a high-value credit as elevated at the policy threshold", () => {
    const preview = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "0.00" }), {
      direction: "credit",
      amount: "500.00",
      currencyCode: "usd",
      reasonCode: "dispute-resolution",
      selfBenefiting: false,
      reversalAfterFundsSettled: false,
    });

    expect(preview.high_value).toBe(true);
    expect(preview.requires_second_approval).toBe(true);
    expect(preview.elevation_reasons).toEqual(["high-value"]);
  });

  it("does not flag a credit strictly below the high-value credit threshold", () => {
    const preview = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "0.00" }), {
      direction: "credit",
      amount: "499.99",
      currencyCode: "usd",
      reasonCode: "dispute-resolution",
      selfBenefiting: false,
      reversalAfterFundsSettled: false,
    });

    expect(preview.high_value).toBe(false);
    expect(preview.requires_second_approval).toBe(false);
    expect(preview.elevation_reasons).toEqual([]);
  });

  it("flags a credit above the high-value credit threshold", () => {
    const preview = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "0.00" }), {
      direction: "credit",
      amount: "500.01",
      currencyCode: "usd",
      reasonCode: "dispute-resolution",
      selfBenefiting: false,
      reversalAfterFundsSettled: false,
    });

    expect(preview.high_value).toBe(true);
    expect(preview.elevation_reasons).toEqual(["high-value"]);
  });

  it("resolves the high-value debit threshold independently, at its own boundary", () => {
    const controls = {
      highValueCreditThresholdAmount: "500.00",
      highValueDebitThresholdAmount: "100.00",
      recentAuthMaxAgeMinutes: 15,
    };
    const below = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "1000.00" }), {
      direction: "debit",
      amount: "99.99",
      currencyCode: "usd",
      reasonCode: "operational-error",
      selfBenefiting: false,
      reversalAfterFundsSettled: false,
      controls,
    });
    const atThreshold = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "1000.00" }), {
      direction: "debit",
      amount: "100.00",
      currencyCode: "usd",
      reasonCode: "operational-error",
      selfBenefiting: false,
      reversalAfterFundsSettled: false,
      controls,
    });

    expect(below.high_value).toBe(false);
    expect(atThreshold.high_value).toBe(true);
    expect(atThreshold.controls.high_value_debit_threshold_amount).toBe("100.00");
  });

  it("surfaces the self-benefiting outright block", () => {
    const preview = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "0.00" }), {
      direction: "credit",
      amount: "1.00",
      currencyCode: "usd",
      reasonCode: "goodwill-cash-credit",
      selfBenefiting: true,
      reversalAfterFundsSettled: false,
    });

    expect(preview.self_benefiting).toBe(true);
    expect(preview.blocked_reason).toBe("self-benefiting");
  });

  it("carries the reversal-after-settlement elevation reason", () => {
    const preview = buildWalletAdjustmentPreview(walletState({ availableBalanceAmount: "100.00" }), {
      direction: "debit",
      amount: "1.00",
      currencyCode: "usd",
      reasonCode: "transaction-correction",
      selfBenefiting: false,
      reversalAfterFundsSettled: true,
    });

    expect(preview.elevation_reasons).toContain("reversal-after-settlement");
    expect(preview.requires_second_approval).toBe(true);
  });
});

describe("computeWalletBalanceRevision", () => {
  it("changes when the posted-entry count or balance moves", () => {
    const base = walletState({ availableBalanceAmount: "10.00", updatedAt: "2026-07-13T00:00:00.000Z" });
    const moved = walletState({ availableBalanceAmount: "12.00", updatedAt: "2026-07-13T00:01:00.000Z" });

    expect(computeWalletBalanceRevision(base)).toBe(computeWalletBalanceRevision(base));
    expect(computeWalletBalanceRevision(base)).not.toBe(computeWalletBalanceRevision(moved));
    expect(computeWalletBalanceRevision(base)).toMatch(/^wbr_[a-f0-9]{24}$/);
  });
});
