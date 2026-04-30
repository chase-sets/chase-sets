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
}>;

export type SettlementBalanceCreditResolver = Readonly<{
  resolveBalanceCredit(input: Readonly<{
    buyerAccountId: AccountId;
    currencyCode: CurrencyCode | string;
    requestedAmount: string;
    orderTotalAmount: string;
  }>): Promise<SettlementBalanceCreditResolution>;
}>;

function minMoney(...values: readonly string[]) {
  return values.reduce((minimum, value) =>
    compareMoney(value, minimum) < 0 ? value : minimum
  );
}

export function createSettlementBalanceCreditResolver(
  db: PgQueryable,
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
      const appliedAmount = minMoney(
        requestedAmount,
        availableAmount,
        orderTotalAmount,
      );

      return {
        requestedAmount,
        appliedAmount,
        remainingExternalAmount: subtractMoney(orderTotalAmount, appliedAmount),
      };
    },
  };
}
