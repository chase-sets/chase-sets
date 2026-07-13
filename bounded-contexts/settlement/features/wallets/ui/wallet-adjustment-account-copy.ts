import { t } from "@chase-sets/localization";
import type { Tone } from "@chase-sets/design-system";

/**
 * Account-facing Wallet Adjustment copy, deliberately separate from the
 * platform-admin labels in `wallet-adjustment-copy.ts`. Only the statuses an
 * account holder can actually see reach the ledger (`posted`/`reversed`);
 * `requested`/`approved`/`rejected` never post a balance effect or a notice,
 * so this still labels them defensively (the detail route has no permission
 * gate beyond "this is your own account," so a not-yet-posted reference is
 * theoretically reachable even though it is never linked from anywhere the
 * account holder would see).
 */
export type WalletAdjustmentAccountStatus = "requested" | "approved" | "rejected" | "posted" | "reversed";

const STATUS_LABEL_KEYS: Record<WalletAdjustmentAccountStatus, string> = {
  requested: "settlement.features.wallets.ui.walletAdjustmentAccountCopy.status.under.review",
  approved: "settlement.features.wallets.ui.walletAdjustmentAccountCopy.status.under.review",
  rejected: "settlement.features.wallets.ui.walletAdjustmentAccountCopy.status.not.applied",
  posted: "settlement.features.wallets.ui.walletAdjustmentAccountCopy.status.posted",
  reversed: "settlement.features.wallets.ui.walletAdjustmentAccountCopy.status.reversed",
};

const STATUS_TONES: Record<WalletAdjustmentAccountStatus, Tone> = {
  requested: "warning",
  approved: "warning",
  rejected: "neutral",
  posted: "success",
  reversed: "neutral",
};

export function walletAdjustmentAccountStatusLabel(status: WalletAdjustmentAccountStatus): string {
  return t(STATUS_LABEL_KEYS[status]);
}

export function walletAdjustmentAccountStatusTone(status: WalletAdjustmentAccountStatus): Tone {
  return STATUS_TONES[status];
}

export function walletAdjustmentAccountDirectionLabel(direction: "credit" | "debit"): string {
  return direction === "credit"
    ? t("settlement.features.wallets.ui.walletAdjustmentAccountCopy.direction.credit")
    : t("settlement.features.wallets.ui.walletAdjustmentAccountCopy.direction.debit");
}

export function walletAdjustmentAccountDirectionTone(direction: "credit" | "debit"): Tone {
  return direction === "credit" ? "success" : "danger";
}
