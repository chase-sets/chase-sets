import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  subtractMoney,
  type CurrencyCode,
} from "../../../support/runtime-support/common";
import { getWallet } from "../read-model/queries";

export type SettlementBalanceCreditResolution = Readonly<{
  requestedAmount: string;
  appliedAmount: string;
  remainingExternalAmount: string;
  /** Set when a positive balance would otherwise have applied but was withheld -- see `blockedReason` docs below. */
  blockedReason: "wallet-terms-not-accepted" | null;
}>;

export type SettlementBalanceCreditResolver = Readonly<{
  resolveBalanceCredit(
    input: Readonly<{
      buyerAccountId: AccountId;
      currencyCode: CurrencyCode | string;
      requestedAmount: string;
      orderTotalAmount: string;
    }>,
  ): Promise<SettlementBalanceCreditResolution>;
}>;

/**
 * The buyer-facing side of wallet-adjustment-enabled marketplace access:
 * spending a wallet balance built up (in part) from wallet adjustments as
 * checkout credit. Resolved cross-context, not imported, so Settlement stays
 * the only reader of its own wallet storage -- see
 * `bounded-contexts/settlement/context.json` `hostPorts` and
 * `deployables/platform-api/src/app.ts` for how this is wired from Identity.
 */
export type TermsAcceptanceResolver = Readonly<{
  resolveTermsAcceptanceStatus(
    subject: Readonly<{ accountId: AccountId }>,
  ): Promise<Readonly<{ accepted: boolean; requiredVersion: string }>>;
}>;

export type SettlementBalanceCreditResolverDeps = Readonly<{
  /**
   * Absent or unresolved counts as NOT accepted -- fail closed. A buyer can
   * never draw down wallet balance as checkout credit unless a wired
   * resolver affirmatively proves they hold the active Terms of Service
   * version. This is deliberate defense-in-depth: it holds even if a caller
   * forgets to surface the resulting `blockedReason` in its own UI.
   */
  termsAcceptanceResolver?: TermsAcceptanceResolver;
}>;

function minMoney(...values: readonly string[]) {
  return values.reduce((minimum, value) => (compareMoney(value, minimum) < 0 ? value : minimum));
}

export function createSettlementBalanceCreditResolver(
  db: PgQueryable,
  deps: SettlementBalanceCreditResolverDeps = {},
): SettlementBalanceCreditResolver {
  return {
    async resolveBalanceCredit(input) {
      normalizeCurrencyCode(String(input.currencyCode));
      const wallet = await getWallet(db, input.buyerAccountId);
      const requestedAmount = normalizeMoneyAmount(input.requestedAmount, {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
      const orderTotalAmount = normalizeMoneyAmount(input.orderTotalAmount, {
        fieldName: "Order total",
        allowZero: true,
      });
      const availableAmount = normalizeMoneyAmount(wallet.available_balance_amount, {
        fieldName: "Available balance",
        allowZero: true,
      });
      const eligibleAmount = minMoney(requestedAmount, availableAmount, orderTotalAmount);

      if (compareMoney(eligibleAmount, "0.00") <= 0) {
        return {
          requestedAmount,
          appliedAmount: "0.00",
          remainingExternalAmount: subtractMoney(orderTotalAmount, "0.00"),
          blockedReason: null,
        };
      }

      const termsStatus = await deps.termsAcceptanceResolver?.resolveTermsAcceptanceStatus({
        accountId: input.buyerAccountId,
      });
      if (!termsStatus?.accepted) {
        return {
          requestedAmount,
          appliedAmount: "0.00",
          remainingExternalAmount: orderTotalAmount,
          blockedReason: "wallet-terms-not-accepted",
        };
      }

      return {
        requestedAmount,
        appliedAmount: eligibleAmount,
        remainingExternalAmount: subtractMoney(orderTotalAmount, eligibleAmount),
        blockedReason: null,
      };
    },
  };
}
