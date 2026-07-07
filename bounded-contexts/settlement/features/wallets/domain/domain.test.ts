import { describe, expect, it } from "vitest";
import { decideWallet, evolveWallet, initialWalletState } from "./domain";

function applyCommands(commands: readonly Parameters<typeof decideWallet>[1][]) {
  return commands.reduce(
    (state, command) => decideWallet(state, command).reduce(evolveWallet, state),
    initialWalletState,
  );
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
});
