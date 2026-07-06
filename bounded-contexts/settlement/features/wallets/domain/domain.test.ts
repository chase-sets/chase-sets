import { describe, expect, it } from "vitest";
import { decideWallet, evolveWallet, initialWalletState } from "./domain";

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
