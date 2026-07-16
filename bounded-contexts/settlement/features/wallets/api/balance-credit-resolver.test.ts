import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, PaymentId } from "@chase-sets/primitives/typed-ids";
import { balanceCreditHoldId, createSettlementBalanceCreditResolver } from "./balance-credit-resolver";

function fakeDb(availableBalanceAmount: string, activeHoldAmount = "0.00") {
  return {
    query: vi.fn(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM settlement_wallet_spend_holds")) {
        return { rows: [{ amount: activeHoldAmount }] };
      }
      return {
        rows: [
          {
            account_id: "acc_1",
            currency_code: "usd",
            pending_balance_amount: "0.00",
            available_balance_amount: availableBalanceAmount,
            total_credited_amount: availableBalanceAmount,
            total_debited_amount: "0.00",
            negative_balance_status: "in-good-standing",
            negative_balance_started_at: null,
            collections_escalated_at: null,
            opened_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
    }),
  } as unknown as PgQueryable;
}

function fakeDbWithAvailableBalance(availableBalanceAmount: string) {
  return fakeDb(availableBalanceAmount);
}

const acceptedTerms = {
  resolveTermsAcceptanceStatus: vi.fn(async () => ({ accepted: true, requiredVersion: "v2" })),
};

describe("createSettlementBalanceCreditResolver", () => {
  const input = {
    buyerAccountId: "acc_1" as AccountId,
    currencyCode: "usd",
    requestedAmount: "20.00",
    orderTotalAmount: "50.00",
  };

  it("fails closed when no terms acceptance resolver is wired at all", async () => {
    const resolver = createSettlementBalanceCreditResolver(fakeDbWithAvailableBalance("30.00"));

    const result = await resolver.resolveBalanceCredit(input);

    expect(result.appliedAmount).toBe("0.00");
    expect(result.remainingExternalAmount).toBe("50.00");
    expect(result.blockedReason).toBe("wallet-terms-not-accepted");
  });

  it("fails closed when the wired resolver reports Terms not accepted", async () => {
    const termsAcceptanceResolver = {
      resolveTermsAcceptanceStatus: vi.fn(async () => ({ accepted: false, requiredVersion: "v2" })),
    };
    const resolver = createSettlementBalanceCreditResolver(fakeDbWithAvailableBalance("30.00"), {
      termsAcceptanceResolver,
    });

    const result = await resolver.resolveBalanceCredit(input);

    expect(result.appliedAmount).toBe("0.00");
    expect(result.blockedReason).toBe("wallet-terms-not-accepted");
    expect(termsAcceptanceResolver.resolveTermsAcceptanceStatus).toHaveBeenCalledWith({
      accountId: "acc_1",
    });
  });

  it("applies wallet balance once the wired resolver reports Terms accepted", async () => {
    const termsAcceptanceResolver = {
      resolveTermsAcceptanceStatus: vi.fn(async () => ({ accepted: true, requiredVersion: "v2" })),
    };
    const resolver = createSettlementBalanceCreditResolver(fakeDbWithAvailableBalance("30.00"), {
      termsAcceptanceResolver,
    });

    const result = await resolver.resolveBalanceCredit(input);

    expect(result.appliedAmount).toBe("20.00");
    expect(result.remainingExternalAmount).toBe("30.00");
    expect(result.blockedReason).toBeNull();
  });

  it("never checks Terms acceptance when no balance would apply anyway", async () => {
    const termsAcceptanceResolver = {
      resolveTermsAcceptanceStatus: vi.fn(async () => ({ accepted: false, requiredVersion: "v2" })),
    };
    const resolver = createSettlementBalanceCreditResolver(fakeDbWithAvailableBalance("0.00"), {
      termsAcceptanceResolver,
    });

    const result = await resolver.resolveBalanceCredit(input);

    expect(result.appliedAmount).toBe("0.00");
    expect(result.blockedReason).toBeNull();
    expect(termsAcceptanceResolver.resolveTermsAcceptanceStatus).not.toHaveBeenCalled();
  });

  it("subtracts active spend holds from spendable availability", async () => {
    // $30 available but $20 already reserved by an in-flight checkout: only $10
    // remains spendable, so the resolved credit is capped to $10.
    const resolver = createSettlementBalanceCreditResolver(fakeDb("30.00", "20.00"), {
      termsAcceptanceResolver: acceptedTerms,
    });

    const result = await resolver.resolveBalanceCredit(input);

    expect(result.appliedAmount).toBe("10.00");
    expect(result.remainingExternalAmount).toBe("40.00");
    expect(result.blockedReason).toBeNull();
  });

  it("applies zero once holds have reserved the whole balance", async () => {
    const resolver = createSettlementBalanceCreditResolver(fakeDb("30.00", "30.00"), {
      termsAcceptanceResolver: acceptedTerms,
    });

    const result = await resolver.resolveBalanceCredit(input);

    expect(result.appliedAmount).toBe("0.00");
    expect(result.remainingExternalAmount).toBe("50.00");
  });

  describe("placeSpendHold", () => {
    const context = { tenantId: "tnt_test", audit: { performedByUserId: "usr_test", forAccountId: "acc_1" } } as never;
    const holdInput = {
      paymentId: "pay_1" as PaymentId,
      buyerAccountId: "acc_1" as AccountId,
      currencyCode: "usd",
      requestedAmount: "20.00",
    };

    it("delegates to the wallet port with the payment-derived hold id and returns the held amount", async () => {
      const placeSpendHold = vi.fn(async () => ({ accountId: "acc_1" as AccountId, holdId: "x", heldAmount: "20.00" }));
      const releaseSpendHold = vi.fn(async () => ({ accountId: "acc_1" as AccountId, holdId: "x", released: true }));
      const resolver = createSettlementBalanceCreditResolver(fakeDb("30.00"), {
        walletSpendHolds: { placeSpendHold, releaseSpendHold },
      });

      const result = await resolver.placeSpendHold(holdInput, context);

      expect(result.heldAmount).toBe("20.00");
      expect(placeSpendHold).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acc_1",
          holdId: balanceCreditHoldId("pay_1"),
          paymentId: "pay_1",
          amount: "20.00",
          currencyCode: "usd",
          expiresAt: expect.any(String),
        }),
        context,
      );
    });

    it("returns the capped held amount when the port reserves less than requested", async () => {
      const placeSpendHold = vi.fn(async () => ({ accountId: "acc_1" as AccountId, holdId: "x", heldAmount: "5.00" }));
      const releaseSpendHold = vi.fn(async () => ({ accountId: "acc_1" as AccountId, holdId: "x", released: true }));
      const resolver = createSettlementBalanceCreditResolver(fakeDb("30.00"), {
        walletSpendHolds: { placeSpendHold, releaseSpendHold },
      });

      const result = await resolver.placeSpendHold(holdInput, context);

      expect(result.heldAmount).toBe("5.00");
    });

    it("is a no-op returning the requested amount when no wallet write port is wired", async () => {
      const resolver = createSettlementBalanceCreditResolver(fakeDb("30.00"));

      const result = await resolver.placeSpendHold(holdInput, context);

      expect(result.heldAmount).toBe("20.00");
    });
  });
});
