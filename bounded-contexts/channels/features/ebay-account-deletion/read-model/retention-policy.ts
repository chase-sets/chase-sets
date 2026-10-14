import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const ebayReceiptCustomRetention: readonly BcRetentionExemption[] = [
  {
    tableName: "channels_ebay_account_deletion_receipts",
    owner: "channels",
    reason:
      "The registered channels.ebay-account-deletion-receipt-expiry runner owns deletion: indexed 500-row cutoff continuations, fixed 1800-second starts/budget, and incomplete signals. This is not an exemption from expiry; the generic shared sweep cannot express this complete-drain law.",
  },
];
