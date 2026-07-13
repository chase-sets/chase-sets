import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { createSettlementBalanceCreditResolver } from "./balance-credit-resolver";

function fakeDbWithAvailableBalance(availableBalanceAmount: string) {
  return {
    query: vi.fn(async () => ({
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
    })),
  } as unknown as PgQueryable;
}

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
});
