import { describe, expect, it } from "vitest";
import {
  decideWalletAdjustment,
  evolveWalletAdjustment,
  initialWalletAdjustmentState,
  WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
  type WalletAdjustmentCommand,
  type WalletAdjustmentState,
} from "./wallet-adjustment";

function apply(state: WalletAdjustmentState, command: WalletAdjustmentCommand): WalletAdjustmentState {
  return decideWalletAdjustment(state, command).reduce(evolveWalletAdjustment, state);
}

function requested(overrides: Partial<Parameters<typeof requestCommand>[0]> = {}): WalletAdjustmentState {
  return apply(initialWalletAdjustmentState, requestCommand(overrides));
}

function requestCommand(
  overrides: Partial<{
    direction: "credit" | "debit";
    amount: string;
    reasonCode: WalletAdjustmentCommand extends { reasonCode: infer R } ? R : never;
    explanation: string | null;
    selfBenefiting: boolean;
    reversalOfAdjustmentId: string | null;
  }> = {},
): WalletAdjustmentCommand {
  return {
    type: "RequestWalletAdjustment",
    adjustmentId: "wad_1" as never,
    targetAccountId: "acc_seller" as never,
    direction: (overrides.direction ?? "credit") as "credit" | "debit",
    amount: overrides.amount ?? "25.00",
    currencyCode: "usd",
    reasonCode: (overrides.reasonCode ?? "goodwill-cash-credit") as never,
    explanation: overrides.explanation ?? null,
    evidenceReferences: ["case-123"],
    requestedBy: "usr_requester" as never,
    requestedAt: "2026-07-10T00:00:00.000Z",
    selfBenefiting: overrides.selfBenefiting ?? false,
    reversalOfAdjustmentId: (overrides.reversalOfAdjustmentId ?? null) as never,
  };
}

const approveCommand: WalletAdjustmentCommand = {
  type: "ApproveWalletAdjustment",
  approvedBy: "usr_approver" as never,
  approvedAt: "2026-07-10T01:00:00.000Z",
  controls: WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
  createsOrIncreasesNegativeBalance: false,
  reversalAfterFundsSettled: false,
  elevationApprovedBy: null,
};

describe("wallet adjustment domain lifecycle", () => {
  it("records a request with normalized amount and structured reason code", () => {
    const state = requested();
    expect(state.status).toBe("requested");
    expect(state.amount).toBe("25.00");
    expect(state.reasonCode).toBe("goodwill-cash-credit");
    expect(state.evidenceReferences).toEqual(["case-123"]);
  });

  it("requires a free-text explanation for the catch-all reason code", () => {
    expect(() => requested({ reasonCode: "other-with-required-detail" as never })).toThrow(
      /requires a free-text explanation/,
    );
    const state = requested({
      reasonCode: "other-with-required-detail" as never,
      explanation: "manual keying error on case 9",
    });
    expect(state.status).toBe("requested");
    expect(state.explanation).toBe("manual keying error on case 9");
  });

  it("rejects unsupported reason codes and non-positive amounts", () => {
    expect(() => requested({ reasonCode: "made-up" as never })).toThrow(/reason code is not supported/);
    expect(() => requested({ amount: "0.00" })).toThrow(/greater than zero/);
  });

  it("advances requested -> approved -> posted", () => {
    const approved = apply(requested(), approveCommand);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("usr_approver");
    expect(approved.controls).toEqual(WALLET_ADJUSTMENT_CONTROLS_DEFAULT);

    const posted = apply(approved, {
      type: "PostWalletAdjustment",
      ledgerEntryId: "led_1" as never,
      postedAt: "2026-07-10T02:00:00.000Z",
      availableBalanceBefore: "0.00",
      availableBalanceAfter: "25.00",
    });
    expect(posted.status).toBe("posted");
    expect(posted.postedLedgerEntryId).toBe("led_1");
    expect(posted.availableBalanceBefore).toBe("0.00");
    expect(posted.availableBalanceAfter).toBe("25.00");
  });

  it("blocks self-approval", () => {
    expect(() => apply(requested(), { ...approveCommand, approvedBy: "usr_requester" as never })).toThrow(
      /cannot be approved by its requester/,
    );
  });

  it("blocks a self-benefiting adjustment outright", () => {
    expect(() => apply(requested({ selfBenefiting: true }), approveCommand)).toThrow(
      /self-benefiting Wallet Adjustment is blocked outright/,
    );
  });

  it("requires a distinct elevated approver for a high-value credit", () => {
    const highValue = requested({ amount: "500.00" });
    expect(() => apply(highValue, approveCommand)).toThrow(/requires a second, elevated approval/);
    expect(() => apply(highValue, { ...approveCommand, elevationApprovedBy: "usr_approver" as never })).toThrow(
      /distinct from the requester and the primary approver/,
    );

    const approved = apply(highValue, { ...approveCommand, elevationApprovedBy: "usr_elevated" as never });
    expect(approved.elevationRequired).toBe(true);
    expect(approved.elevationReasons).toContain("high-value");
    expect(approved.elevationApprovedBy).toBe("usr_elevated");
  });

  it("elevates when the debit creates or increases a negative balance", () => {
    const approved = apply(requested({ direction: "debit", amount: "10.00" }), {
      ...approveCommand,
      createsOrIncreasesNegativeBalance: true,
      elevationApprovedBy: "usr_elevated" as never,
    });
    expect(approved.elevationRequired).toBe(true);
    expect(approved.elevationReasons).toContain("negative-balance");
  });

  it("elevates a reversal-after-settlement approval", () => {
    const approved = apply(requested({ reversalOfAdjustmentId: "wad_orig" }), {
      ...approveCommand,
      reversalAfterFundsSettled: true,
      elevationApprovedBy: "usr_elevated" as never,
    });
    expect(approved.elevationReasons).toContain("reversal-after-settlement");
  });

  it("records a terminal rejection that cannot be approved afterward", () => {
    const rejected = apply(requested(), {
      type: "RejectWalletAdjustment",
      rejectedBy: "usr_approver" as never,
      rejectedAt: "2026-07-10T01:00:00.000Z",
      rejectionReason: "insufficient evidence",
    });
    expect(rejected.status).toBe("rejected");
    expect(() => apply(rejected, approveCommand)).toThrow(/Only a requested Wallet Adjustment can be approved/);
  });

  it("records reversal linkage on the original", () => {
    const posted = apply(apply(requested(), approveCommand), {
      type: "PostWalletAdjustment",
      ledgerEntryId: "led_1" as never,
      postedAt: "2026-07-10T02:00:00.000Z",
      availableBalanceBefore: "0.00",
      availableBalanceAfter: "25.00",
    });
    const reversed = apply(posted, {
      type: "ReverseWalletAdjustment",
      reversalAdjustmentId: "wad_rev" as never,
      reversedBy: "usr_requester" as never,
      reversedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(reversed.status).toBe("reversed");
    expect(reversed.reversedByAdjustmentId).toBe("wad_rev");
  });

  describe("idempotency and invalid transitions", () => {
    it("treats a duplicate request as a no-op", () => {
      const first = requested();
      expect(decideWalletAdjustment(first, requestCommand())).toEqual([]);
    });

    it("treats duplicate approval, post, and reversal as no-ops", () => {
      const approved = apply(requested(), approveCommand);
      expect(decideWalletAdjustment(approved, approveCommand)).toEqual([]);

      const posted = apply(approved, {
        type: "PostWalletAdjustment",
        ledgerEntryId: "led_1" as never,
        postedAt: "2026-07-10T02:00:00.000Z",
        availableBalanceBefore: "0.00",
        availableBalanceAfter: "25.00",
      });
      expect(
        decideWalletAdjustment(posted, {
          type: "PostWalletAdjustment",
          ledgerEntryId: "led_1" as never,
          postedAt: "2026-07-10T02:00:00.000Z",
          availableBalanceBefore: "0.00",
          availableBalanceAfter: "25.00",
        }),
      ).toEqual([]);

      const reversed = apply(posted, {
        type: "ReverseWalletAdjustment",
        reversalAdjustmentId: "wad_rev" as never,
        reversedBy: "usr_requester" as never,
        reversedAt: "2026-07-11T00:00:00.000Z",
      });
      expect(
        decideWalletAdjustment(reversed, {
          type: "ReverseWalletAdjustment",
          reversalAdjustmentId: "wad_rev" as never,
          reversedBy: "usr_requester" as never,
          reversedAt: "2026-07-11T00:00:00.000Z",
        }),
      ).toEqual([]);
    });

    it("cannot post before approval or approve after posting", () => {
      expect(() =>
        apply(requested(), {
          type: "PostWalletAdjustment",
          ledgerEntryId: "led_1" as never,
          postedAt: "2026-07-10T02:00:00.000Z",
          availableBalanceBefore: "0.00",
          availableBalanceAfter: "25.00",
        }),
      ).toThrow(/Only an approved Wallet Adjustment can be posted/);
    });

    it("cannot reverse an adjustment that was never posted", () => {
      expect(() =>
        apply(apply(requested(), approveCommand), {
          type: "ReverseWalletAdjustment",
          reversalAdjustmentId: "wad_rev" as never,
          reversedBy: "usr_requester" as never,
          reversedAt: "2026-07-11T00:00:00.000Z",
        }),
      ).toThrow(/Only a posted Wallet Adjustment can be reversed/);
    });
  });
});
