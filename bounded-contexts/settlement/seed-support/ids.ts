import type { LedgerEntryId, PayoutId } from "@chase-sets/primitives/typed-ids";

export const settlementReservedSeedIds = {
  ledgerEntries: {
    pendingSaleCredit: "led_seed_pending_sale_credit" as LedgerEntryId,
    availableAdjustmentCredit: "led_seed_available_adjustment_credit" as LedgerEntryId,
    payoutDebitCompleted: "led_seed_payout_debit_completed" as LedgerEntryId,
    payoutDebitFailed: "led_seed_payout_debit_failed" as LedgerEntryId,
    payoutReversalFailed: "led_seed_payout_reversal_failed" as LedgerEntryId,
  },
  payouts: {
    completed: "pyo_seed_completed" as PayoutId,
    failed: "pyo_seed_failed" as PayoutId,
  },
} as const;
