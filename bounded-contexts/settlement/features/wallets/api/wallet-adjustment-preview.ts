import { createHash } from "node:crypto";
import type { WalletState } from "../domain/domain";
import {
  WALLET_ADJUSTMENT_CONTROLS_DEFAULT,
  walletAdjustmentSignedAmount,
  type WalletAdjustmentControls,
  type WalletAdjustmentElevationReason,
  type WalletAdjustmentReasonCode,
} from "../domain/wallet-adjustment";
import {
  addMoney,
  compareMoney,
  type CurrencyCode,
  type LedgerEntryDirection,
} from "../../../support/runtime-support/common";

/**
 * A stable, monotonically-advancing token for the authoritative wallet balance
 * an operator previewed. It folds the posted-entry count and the resolved
 * balances so any ledger movement between preview and confirmation changes the
 * token -- the confirmation guard then rejects a stale preview rather than
 * posting an adjustment against balance the operator never saw.
 */
export function computeWalletBalanceRevision(state: WalletState): string {
  const basis = [
    state.entries.length,
    state.availableBalanceAmount,
    state.pendingBalanceAmount,
    state.negativeBalanceStatus,
    state.updatedAt ?? "none",
  ].join("|");
  return `wbr_${createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 24)}`;
}

export type WalletAdjustmentPreviewInput = Readonly<{
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode: CurrencyCode;
  reasonCode: WalletAdjustmentReasonCode;
  selfBenefiting: boolean;
  reversalAfterFundsSettled: boolean;
  controls?: WalletAdjustmentControls;
}>;

export type WalletAdjustmentPreview = Readonly<{
  target_account_id: string;
  direction: LedgerEntryDirection;
  amount: string;
  currency_code: CurrencyCode;
  reason_code: WalletAdjustmentReasonCode;
  balance_revision: string;
  available_balance_before: string;
  available_balance_after: string;
  pending_balance_amount: string;
  cash_equivalent: boolean;
  spendable: boolean;
  payoutable: boolean;
  negative_balance_status: WalletState["negativeBalanceStatus"];
  creates_or_increases_negative_balance: boolean;
  high_value: boolean;
  self_benefiting: boolean;
  blocked_reason: "self-benefiting" | null;
  requires_second_approval: boolean;
  elevation_reasons: readonly WalletAdjustmentElevationReason[];
  controls: Readonly<{
    high_value_credit_threshold_amount: string;
    high_value_debit_threshold_amount: string;
    recent_auth_max_age_minutes: number;
  }>;
}>;

/**
 * Pure projection of what confirming a proposed Wallet Adjustment would do to
 * the authoritative wallet, plus the governance it would require. Mirrors the
 * approval decider's elevation logic so the operator sees the same policy
 * consequence the aggregate will enforce.
 */
export function buildWalletAdjustmentPreview(
  state: WalletState,
  input: WalletAdjustmentPreviewInput,
): WalletAdjustmentPreview {
  const controls = input.controls ?? WALLET_ADJUSTMENT_CONTROLS_DEFAULT;
  const availableBefore = state.availableBalanceAmount;
  const availableAfter = addMoney(availableBefore, walletAdjustmentSignedAmount(input.direction, input.amount));
  const createsOrIncreasesNegativeBalance = input.direction === "debit" && compareMoney(availableAfter, "0.00") < 0;
  const threshold =
    input.direction === "credit" ? controls.highValueCreditThresholdAmount : controls.highValueDebitThresholdAmount;
  const highValue = compareMoney(input.amount, threshold) >= 0;

  const elevationReasons: WalletAdjustmentElevationReason[] = [];
  if (highValue) {
    elevationReasons.push("high-value");
  }
  if (createsOrIncreasesNegativeBalance) {
    elevationReasons.push("negative-balance");
  }
  if (input.reversalAfterFundsSettled) {
    elevationReasons.push("reversal-after-settlement");
  }

  return {
    target_account_id: state.accountId ?? "",
    direction: input.direction,
    amount: input.amount,
    currency_code: input.currencyCode,
    reason_code: input.reasonCode,
    balance_revision: computeWalletBalanceRevision(state),
    available_balance_before: availableBefore,
    available_balance_after: availableAfter,
    pending_balance_amount: state.pendingBalanceAmount,
    cash_equivalent: true,
    spendable: input.direction === "credit",
    payoutable: input.direction === "credit",
    negative_balance_status: state.negativeBalanceStatus,
    creates_or_increases_negative_balance: createsOrIncreasesNegativeBalance,
    high_value: highValue,
    self_benefiting: input.selfBenefiting,
    blocked_reason: input.selfBenefiting ? "self-benefiting" : null,
    requires_second_approval: elevationReasons.length > 0,
    elevation_reasons: elevationReasons,
    controls: {
      high_value_credit_threshold_amount: controls.highValueCreditThresholdAmount,
      high_value_debit_threshold_amount: controls.highValueDebitThresholdAmount,
      recent_auth_max_age_minutes: controls.recentAuthMaxAgeMinutes,
    },
  };
}
