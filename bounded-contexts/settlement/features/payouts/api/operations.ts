import type { AccountId, PayoutId } from "@chase-sets/primitives/typed-ids";
import type { CurrencyCode } from "../../../support/runtime-support/common";

export type SettlementOperationEvent = Readonly<{
  kind:
    | "payout-requested"
    | "platform-balance-insufficient"
    | "provider-transfer-submitted"
    | "provider-payout-submitted"
    | "payout-completed"
    | "payout-failed"
    | "payout-reversal-posted"
    | "money-movement-webhook-ignored";
  accountId?: AccountId | string;
  payoutId?: PayoutId | string;
  amount?: string;
  currencyCode?: CurrencyCode | string;
  providerName?: string;
  providerEventId?: string;
  providerTransferReference?: string | null;
  providerPayoutReference?: string | null;
  reason?: string | null;
  occurredAt: string;
}>;

export type SettlementOperationsRecorder = Readonly<{
  record: (event: SettlementOperationEvent) => void | Promise<void>;
}>;

export function createNoopSettlementOperationsRecorder(): SettlementOperationsRecorder {
  return {
    record: () => undefined,
  };
}
