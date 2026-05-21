import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CurrencyCode } from "../../../support/runtime-support/common";

export type BalanceCreditResolution = Readonly<{
  requestedAmount: string;
  appliedAmount: string;
  remainingExternalAmount: string;
}>;

export interface BalanceCreditResolver {
  resolveBalanceCredit(
    input: Readonly<{
      buyerAccountId: AccountId;
      currencyCode: CurrencyCode;
      requestedAmount: string;
      orderTotalAmount: string;
    }>,
  ): Promise<BalanceCreditResolution>;
}
