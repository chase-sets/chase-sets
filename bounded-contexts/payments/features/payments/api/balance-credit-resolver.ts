import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, PaymentId } from "@chase-sets/primitives/typed-ids";
import type { CurrencyCode } from "../../../support/runtime-support/common";

export type BalanceCreditResolution = Readonly<{
  requestedAmount: string;
  appliedAmount: string;
  remainingExternalAmount: string;
  /** Set by the resolver when a positive balance would otherwise have applied but was withheld (e.g. Terms not accepted). */
  blockedReason?: string | null;
}>;

/** Why a placed balance-credit hold is being released from the Payments side. */
export type BalanceCreditHoldReleaseReason = "payment-failed" | "payment-cancelled";

export interface BalanceCreditResolver {
  resolveBalanceCredit(
    input: Readonly<{
      buyerAccountId: AccountId;
      currencyCode: CurrencyCode;
      requestedAmount: string;
      orderTotalAmount: string;
    }>,
  ): Promise<BalanceCreditResolution>;
  /**
   * Reserves the applied wallet credit for a payment at creation time, closing
   * the concurrent-checkout double-spend window. Returns the amount actually
   * held, which may be less than requested (or "0.00") when a concurrent
   * checkout reserved the balance first. Optional: absent for read-only wirings,
   * in which case the caller applies the resolved amount without a reservation.
   */
  placeSpendHold?(
    input: Readonly<{
      paymentId: PaymentId;
      buyerAccountId: AccountId;
      currencyCode: CurrencyCode;
      requestedAmount: string;
    }>,
    context: EventStoreContext,
  ): Promise<{ heldAmount: string }>;
  /** Releases a payment's spend hold (payment abandoned before creation completed). Idempotent. */
  releaseSpendHold?(
    input: Readonly<{
      paymentId: PaymentId;
      buyerAccountId: AccountId;
      reason: BalanceCreditHoldReleaseReason;
    }>,
    context: EventStoreContext,
  ): Promise<void>;
}
