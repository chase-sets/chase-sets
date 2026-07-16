import { describe, expect, it } from "vitest";
import { decideWallet, evolveWallet, initialWalletState, walletSpendableBalanceAmount } from "./domain";

function applyCommands(commands: readonly Parameters<typeof decideWallet>[1][]) {
  return commands.reduce(
    (state, command) => decideWallet(state, command).reduce(evolveWallet, state),
    initialWalletState,
  );
}

/** Wallet opened with `available` of balance credit ready to spend. */
function walletWithAvailableCredit(availableAmount: string) {
  return applyCommands([
    { type: "OpenWallet", accountId: "acc_buyer" as never, currencyCode: "usd", openedAt: "2026-04-02T00:00:00.000Z" },
    {
      type: "PostLedgerEntry",
      ledgerEntryId: "led_credit" as never,
      kind: "adjustment",
      direction: "credit",
      amount: availableAmount,
      currencyCode: "usd",
      fundsStatus: "available",
      postedAt: "2026-04-02T00:01:00.000Z",
    },
  ]);
}

describe("settlement wallet domain", () => {
  it("opens a wallet, posts a pending credit, and releases it to available balance", () => {
    const openedState = decideWallet(initialWalletState, {
      type: "OpenWallet",
      accountId: "acc_seller" as never,
      currencyCode: "usd",
      openedAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolveWallet, initialWalletState);

    const pendingState = decideWallet(openedState, {
      type: "PostLedgerEntry",
      ledgerEntryId: "led_1" as never,
      kind: "sale",
      direction: "credit",
      amount: "18.50",
      currencyCode: "usd",
      fundsStatus: "pending",
      paymentId: "pay_1" as never,
      postedAt: "2026-04-02T00:01:00.000Z",
    }).reduce(evolveWallet, openedState);

    const availableState = decideWallet(pendingState, {
      type: "MarkLedgerEntryAvailable",
      ledgerEntryId: "led_1" as never,
      availableAt: "2026-04-03T00:00:00.000Z",
    }).reduce(evolveWallet, pendingState);

    expect(availableState.pendingBalanceAmount).toBe("0.00");
    expect(availableState.availableBalanceAmount).toBe("18.50");
    expect(availableState.entries[0]?.fundsStatus).toBe("available");
  });

  it("supports available debits for payouts", () => {
    const creditedState = [
      {
        type: "OpenWallet" as const,
        accountId: "acc_seller" as never,
        currencyCode: "usd" as const,
        openedAt: "2026-04-02T00:00:00.000Z",
      },
      {
        type: "PostLedgerEntry" as const,
        ledgerEntryId: "led_credit" as never,
        kind: "sale" as const,
        direction: "credit" as const,
        amount: "25.00",
        currencyCode: "usd" as const,
        fundsStatus: "available" as const,
        postedAt: "2026-04-02T00:01:00.000Z",
      },
    ].reduce((state, command) => decideWallet(state, command).reduce(evolveWallet, state), initialWalletState);

    const debitedState = decideWallet(creditedState, {
      type: "PostLedgerEntry",
      ledgerEntryId: "led_payout" as never,
      kind: "payout",
      direction: "debit",
      amount: "10.00",
      currencyCode: "usd",
      fundsStatus: "available",
      payoutId: "pyo_1" as never,
      postedAt: "2026-04-02T00:02:00.000Z",
    }).reduce(evolveWallet, creditedState);

    expect(debitedState.availableBalanceAmount).toBe("15.00");
    expect(debitedState.totalDebitedAmount).toBe("10.00");
  });

  it("rejects available debits that exceed the available balance", () => {
    const creditedState = [
      {
        type: "OpenWallet" as const,
        accountId: "acc_seller" as never,
        currencyCode: "usd" as const,
        openedAt: "2026-04-02T00:00:00.000Z",
      },
      {
        type: "PostLedgerEntry" as const,
        ledgerEntryId: "led_credit" as never,
        kind: "sale" as const,
        direction: "credit" as const,
        amount: "10.00",
        currencyCode: "usd" as const,
        fundsStatus: "available" as const,
        postedAt: "2026-04-02T00:01:00.000Z",
      },
    ].reduce((state, command) => decideWallet(state, command).reduce(evolveWallet, state), initialWalletState);

    expect(() =>
      decideWallet(creditedState, {
        type: "PostLedgerEntry",
        ledgerEntryId: "led_payout" as never,
        kind: "payout",
        direction: "debit",
        amount: "12.00",
        currencyCode: "usd",
        fundsStatus: "available",
        payoutId: "pyo_1" as never,
        postedAt: "2026-04-02T00:02:00.000Z",
      }),
    ).toThrow("Available balance is too low for this ledger entry.");
  });

  it("allows explicit chargeback recovery debits to create a negative balance", () => {
    const openedState = decideWallet(initialWalletState, {
      type: "OpenWallet",
      accountId: "acc_seller" as never,
      currencyCode: "usd",
      openedAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolveWallet, initialWalletState);

    const debitedState = decideWallet(openedState, {
      type: "PostLedgerEntry",
      ledgerEntryId: "led_chargeback_dp_123_ord_1" as never,
      kind: "adjustment",
      direction: "debit",
      amount: "12.00",
      currencyCode: "usd",
      fundsStatus: "available",
      paymentId: "pay_1" as never,
      postedAt: "2026-04-02T00:02:00.000Z",
      allowNegativeBalance: true,
    }).reduce(evolveWallet, openedState);

    expect(debitedState.availableBalanceAmount).toBe("-12.00");
    expect(debitedState.totalDebitedAmount).toBe("12.00");
    expect(debitedState.negativeBalanceStatus).toBe("negative");
    expect(debitedState.negativeBalanceStartedAt).toBe("2026-04-02T00:02:00.000Z");
  });

  it("emits lifecycle events for negative transition, collections, and recovery", () => {
    const negativeState = applyCommands([
      {
        type: "OpenWallet",
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        openedAt: "2026-04-02T00:00:00.000Z",
      },
      {
        type: "PostLedgerEntry",
        ledgerEntryId: "led_chargeback" as never,
        kind: "adjustment",
        direction: "debit",
        amount: "125.00",
        currencyCode: "usd",
        fundsStatus: "available",
        postedAt: "2026-04-02T00:02:00.000Z",
        allowNegativeBalance: true,
      },
    ]);

    const collectionsEvents = decideWallet(negativeState, {
      type: "EvaluateNegativeBalanceCollections",
      collectionsThresholdAmount: "100.00",
      collectionsGracePeriodDays: 14,
      evaluatedAt: "2026-04-16T00:02:00.000Z",
    });
    const collectionsState = collectionsEvents.reduce(evolveWallet, negativeState);

    expect(collectionsEvents).toEqual([
      {
        type: "settlement.wallet.negative-balance-collections-opened",
        data: {
          accountId: "acc_seller",
          balanceAmount: "-125.00",
          negativeSince: "2026-04-02T00:02:00.000Z",
          thresholdAmount: "100.00",
          gracePeriodDays: 14,
          openedAt: "2026-04-16T00:02:00.000Z",
        },
      },
    ]);
    expect(collectionsState.negativeBalanceStatus).toBe("collections");

    const recoveryEvents = decideWallet(collectionsState, {
      type: "PostLedgerEntry",
      ledgerEntryId: "led_repayment" as never,
      kind: "adjustment",
      direction: "credit",
      amount: "125.00",
      currencyCode: "usd",
      fundsStatus: "available",
      postedAt: "2026-04-16T00:05:00.000Z",
    });
    const recoveredState = recoveryEvents.reduce(evolveWallet, collectionsState);

    expect(recoveryEvents.map((event) => event.type)).toEqual([
      "settlement.wallet.ledger-entry-posted",
      "settlement.wallet.negative-balance-recovered",
    ]);
    expect(recoveredState.availableBalanceAmount).toBe("0.00");
    expect(recoveredState.negativeBalanceStatus).toBe("in-good-standing");
    expect(recoveredState.negativeBalanceStartedAt).toBeNull();
    expect(recoveredState.collectionsEscalatedAt).toBeNull();
  });

  it("does not escalate collections before the configured threshold and grace period", () => {
    const negativeState = applyCommands([
      {
        type: "OpenWallet",
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        openedAt: "2026-04-02T00:00:00.000Z",
      },
      {
        type: "PostLedgerEntry",
        ledgerEntryId: "led_chargeback" as never,
        kind: "adjustment",
        direction: "debit",
        amount: "99.99",
        currencyCode: "usd",
        fundsStatus: "available",
        postedAt: "2026-04-02T00:02:00.000Z",
        allowNegativeBalance: true,
      },
    ]);

    expect(
      decideWallet(negativeState, {
        type: "EvaluateNegativeBalanceCollections",
        collectionsThresholdAmount: "100.00",
        collectionsGracePeriodDays: 14,
        evaluatedAt: "2026-04-30T00:02:00.000Z",
      }),
    ).toEqual([]);

    const deeperNegativeState = decideWallet(negativeState, {
      type: "PostLedgerEntry",
      ledgerEntryId: "led_chargeback_2" as never,
      kind: "adjustment",
      direction: "debit",
      amount: "0.01",
      currencyCode: "usd",
      fundsStatus: "available",
      postedAt: "2026-04-03T00:02:00.000Z",
      allowNegativeBalance: true,
    }).reduce(evolveWallet, negativeState);

    expect(
      decideWallet(deeperNegativeState, {
        type: "EvaluateNegativeBalanceCollections",
        collectionsThresholdAmount: "100.00",
        collectionsGracePeriodDays: 14,
        evaluatedAt: "2026-04-15T00:02:00.000Z",
      }),
    ).toEqual([]);
  });

  it("rejects duplicate ledger entry ids", () => {
    const state = [
      {
        type: "OpenWallet" as const,
        accountId: "acc_seller" as never,
        currencyCode: "usd" as const,
        openedAt: "2026-04-02T00:00:00.000Z",
      },
      {
        type: "PostLedgerEntry" as const,
        ledgerEntryId: "led_1" as never,
        kind: "sale" as const,
        direction: "credit" as const,
        amount: "10.00",
        currencyCode: "usd" as const,
        fundsStatus: "available" as const,
        postedAt: "2026-04-02T00:01:00.000Z",
      },
    ].reduce(
      (currentState, command) => decideWallet(currentState, command).reduce(evolveWallet, currentState),
      initialWalletState,
    );

    expect(() =>
      decideWallet(state, {
        type: "PostLedgerEntry",
        ledgerEntryId: "led_1" as never,
        kind: "adjustment",
        direction: "credit",
        amount: "1.00",
        currencyCode: "usd",
        fundsStatus: "available",
        postedAt: "2026-04-02T00:02:00.000Z",
      }),
    ).toThrow("Ledger entry has already been posted.");
  });

  describe("buyer-spend holds", () => {
    it("reserves against available balance and reduces spendable without moving money", () => {
      const held = decideWallet(walletWithAvailableCredit("50.00"), {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_1",
        paymentId: "pay_1" as never,
        amount: "50.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:02:00.000Z",
      }).reduce(evolveWallet, walletWithAvailableCredit("50.00"));

      expect(held.availableBalanceAmount).toBe("50.00");
      expect(held.heldBalanceAmount).toBe("50.00");
      expect(walletSpendableBalanceAmount(held)).toBe("0.00");
      expect(held.spendHolds[0]?.status).toBe("active");
    });

    it("caps a second hold to the balance still unheld (concurrent double-spend guard)", () => {
      const afterFirstHold = applyCommands([
        {
          type: "OpenWallet",
          accountId: "acc_buyer" as never,
          currencyCode: "usd",
          openedAt: "2026-04-02T00:00:00.000Z",
        },
        {
          type: "PostLedgerEntry",
          ledgerEntryId: "led_credit" as never,
          kind: "adjustment",
          direction: "credit",
          amount: "50.00",
          currencyCode: "usd",
          fundsStatus: "available",
          postedAt: "2026-04-02T00:01:00.000Z",
        },
        {
          type: "PlaceSpendHold",
          holdId: "hold_balance_credit_pay_1",
          paymentId: "pay_1" as never,
          amount: "50.00",
          currencyCode: "usd",
          placedAt: "2026-04-02T00:02:00.000Z",
        },
      ]);

      const secondHoldEvents = decideWallet(afterFirstHold, {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_2",
        paymentId: "pay_2" as never,
        amount: "50.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:03:00.000Z",
      });

      // Nothing left to reserve: the second checkout is capped to zero, so the
      // same $50 is never held twice.
      expect(secondHoldEvents).toHaveLength(0);
    });

    it("caps a partially-overlapping hold to the remaining unheld balance", () => {
      const afterThirtyHeld = decideWallet(walletWithAvailableCredit("50.00"), {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_1",
        amount: "30.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:02:00.000Z",
      }).reduce(evolveWallet, walletWithAvailableCredit("50.00"));

      const [placed] = decideWallet(afterThirtyHeld, {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_2",
        amount: "50.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:03:00.000Z",
      });

      expect(placed?.type).toBe("settlement.wallet.spend-hold-placed");
      expect(placed?.type === "settlement.wallet.spend-hold-placed" ? placed.data.amount : null).toBe("20.00");
    });

    it("is idempotent for a repeated hold id", () => {
      const afterHold = decideWallet(walletWithAvailableCredit("50.00"), {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_1",
        amount: "50.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:02:00.000Z",
      }).reduce(evolveWallet, walletWithAvailableCredit("50.00"));

      const replay = decideWallet(afterHold, {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_1",
        amount: "50.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:02:30.000Z",
      });

      expect(replay).toHaveLength(0);
    });

    it("restores spendable balance when a hold is released, and is idempotent", () => {
      const afterHold = decideWallet(walletWithAvailableCredit("50.00"), {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_1",
        amount: "50.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:02:00.000Z",
      }).reduce(evolveWallet, walletWithAvailableCredit("50.00"));

      const released = decideWallet(afterHold, {
        type: "ReleaseSpendHold",
        holdId: "hold_balance_credit_pay_1",
        reason: "payment-failed",
        releasedAt: "2026-04-02T00:05:00.000Z",
      }).reduce(evolveWallet, afterHold);

      expect(released.heldBalanceAmount).toBe("0.00");
      expect(released.availableBalanceAmount).toBe("50.00");
      expect(walletSpendableBalanceAmount(released)).toBe("50.00");
      expect(released.spendHolds[0]?.status).toBe("released");

      // Redelivered release (e.g. capture retried after failure) is a no-op.
      const replay = decideWallet(released, {
        type: "ReleaseSpendHold",
        holdId: "hold_balance_credit_pay_1",
        reason: "payment-failed",
        releasedAt: "2026-04-02T00:06:00.000Z",
      });
      expect(replay).toHaveLength(0);
    });

    it("does not reserve against a negative (receivable) available balance", () => {
      const overdrawn = applyCommands([
        {
          type: "OpenWallet",
          accountId: "acc_buyer" as never,
          currencyCode: "usd",
          openedAt: "2026-04-02T00:00:00.000Z",
        },
        {
          type: "PostLedgerEntry",
          ledgerEntryId: "led_receivable" as never,
          kind: "refund",
          direction: "debit",
          amount: "10.00",
          currencyCode: "usd",
          fundsStatus: "available",
          allowNegativeBalance: true,
          postedAt: "2026-04-02T00:01:00.000Z",
        },
      ]);

      const events = decideWallet(overdrawn, {
        type: "PlaceSpendHold",
        holdId: "hold_balance_credit_pay_1",
        amount: "5.00",
        currencyCode: "usd",
        placedAt: "2026-04-02T00:02:00.000Z",
      });

      expect(events).toHaveLength(0);
    });
  });
});
