import { t } from "@chase-sets/localization";
import type { SelectItem, Tone } from "@chase-sets/design-system";
import {
  WALLET_ADJUSTMENT_DETAIL_REQUIRED_REASON_CODE,
  WALLET_ADJUSTMENT_REASON_CODES,
  type WalletAdjustmentElevationReason,
  type WalletAdjustmentReasonCode,
} from "../domain/wallet-adjustment";
import type { LedgerEntryDirection } from "../../../support/runtime-support/common";
import type { WalletAdjustmentFlowErrorKind } from "../../../support/request-support/wallet-adjustment-flow-error";

/**
 * Every workflow state and API error this guided flow can encounter maps to
 * exactly one deterministic tone/label pair here -- the single place a
 * reviewer checks to confirm every workflow state and API error has
 * deterministic UI, rather than re-deriving copy ad hoc at each call site.
 */

export function walletAdjustmentDirectionLabel(direction: LedgerEntryDirection): string {
  return direction === "credit"
    ? t("settlement.features.wallets.ui.walletAdjustmentCopy.credit")
    : t("settlement.features.wallets.ui.walletAdjustmentCopy.debit");
}

export function walletAdjustmentDirectionTone(direction: LedgerEntryDirection): Tone {
  return direction === "credit" ? "success" : "danger";
}

const REASON_CODE_LABEL_KEYS: Record<WalletAdjustmentReasonCode, string> = {
  "transaction-correction": "settlement.features.wallets.ui.walletAdjustmentCopy.transaction.correction",
  "refund-correction": "settlement.features.wallets.ui.walletAdjustmentCopy.refund.correction",
  "fee-correction": "settlement.features.wallets.ui.walletAdjustmentCopy.fee.correction",
  "dispute-resolution": "settlement.features.wallets.ui.walletAdjustmentCopy.dispute.resolution",
  "fraud-recovery": "settlement.features.wallets.ui.walletAdjustmentCopy.fraud.recovery",
  "support-resolution": "settlement.features.wallets.ui.walletAdjustmentCopy.support.resolution",
  "legal-obligation": "settlement.features.wallets.ui.walletAdjustmentCopy.legal.obligation",
  "goodwill-cash-credit": "settlement.features.wallets.ui.walletAdjustmentCopy.goodwill.cash.credit",
  "operational-error": "settlement.features.wallets.ui.walletAdjustmentCopy.operational.error",
  "other-with-required-detail": "settlement.features.wallets.ui.walletAdjustmentCopy.other.requires.explanation",
};

export function walletAdjustmentReasonCodeLabel(reasonCode: WalletAdjustmentReasonCode): string {
  return t(REASON_CODE_LABEL_KEYS[reasonCode]);
}

export function walletAdjustmentReasonCodeRequiresExplanation(reasonCode: WalletAdjustmentReasonCode): boolean {
  return reasonCode === WALLET_ADJUSTMENT_DETAIL_REQUIRED_REASON_CODE;
}

export function walletAdjustmentReasonCodeItems(): SelectItem[] {
  return WALLET_ADJUSTMENT_REASON_CODES.map((reasonCode) => ({
    value: reasonCode,
    label: walletAdjustmentReasonCodeLabel(reasonCode),
  }));
}

export type WalletAdjustmentStatus = "requested" | "approved" | "rejected" | "posted" | "reversed";

const STATUS_LABEL_KEYS: Record<WalletAdjustmentStatus, string> = {
  requested: "settlement.features.wallets.ui.walletAdjustmentCopy.awaiting.approval",
  approved: "settlement.features.wallets.ui.walletAdjustmentCopy.approved.posting",
  rejected: "settlement.features.wallets.ui.walletAdjustmentCopy.rejected",
  posted: "settlement.features.wallets.ui.walletAdjustmentCopy.posted",
  reversed: "settlement.features.wallets.ui.walletAdjustmentCopy.reversed",
};

const STATUS_TONES: Record<WalletAdjustmentStatus, Tone> = {
  requested: "warning",
  approved: "accent",
  rejected: "neutral",
  posted: "success",
  reversed: "neutral",
};

export function walletAdjustmentStatusLabel(status: WalletAdjustmentStatus): string {
  return t(STATUS_LABEL_KEYS[status]);
}

export function walletAdjustmentStatusTone(status: WalletAdjustmentStatus): Tone {
  return STATUS_TONES[status];
}

const ELEVATION_REASON_LABEL_KEYS: Record<WalletAdjustmentElevationReason, string> = {
  "high-value": "settlement.features.wallets.ui.walletAdjustmentCopy.high.value.amount",
  "negative-balance": "settlement.features.wallets.ui.walletAdjustmentCopy.creates.or.deepens.a.negative.balance",
  "reversal-after-settlement": "settlement.features.wallets.ui.walletAdjustmentCopy.reversal.of.settled.funds",
};

export function walletAdjustmentElevationReasonLabel(reason: WalletAdjustmentElevationReason): string {
  return t(ELEVATION_REASON_LABEL_KEYS[reason]);
}

const FLOW_ERROR_TITLE_KEYS: Record<WalletAdjustmentFlowErrorKind, string> = {
  validation: "settlement.features.wallets.ui.walletAdjustmentCopy.check.the.adjustment.details",
  "stale-preview": "settlement.features.wallets.ui.walletAdjustmentCopy.balance.changed.since.preview",
  "step-up-required": "settlement.features.wallets.ui.walletAdjustmentCopy.reauthentication.required",
  "requires-elevated-approval": "settlement.features.wallets.ui.walletAdjustmentCopy.second.approval.required",
  "self-benefiting-blocked": "settlement.features.wallets.ui.walletAdjustmentCopy.self.benefiting.adjustment.blocked",
  "not-found": "settlement.features.wallets.ui.walletAdjustmentCopy.adjustment.not.found",
  forbidden: "settlement.features.wallets.ui.walletAdjustmentCopy.not.authorized",
  "authentication-required": "settlement.features.wallets.ui.walletAdjustmentCopy.sign.in.required",
  conflict: "settlement.features.wallets.ui.walletAdjustmentCopy.action.could.not.be.completed",
  unknown: "settlement.features.wallets.ui.walletAdjustmentCopy.something.went.wrong",
};

const FLOW_ERROR_TONES: Record<WalletAdjustmentFlowErrorKind, Exclude<Tone, "neutral">> = {
  validation: "warning",
  "stale-preview": "warning",
  "step-up-required": "warning",
  "requires-elevated-approval": "warning",
  "self-benefiting-blocked": "danger",
  "not-found": "danger",
  forbidden: "danger",
  "authentication-required": "danger",
  conflict: "danger",
  unknown: "danger",
};

export function walletAdjustmentFlowErrorTitle(kind: WalletAdjustmentFlowErrorKind): string {
  return t(FLOW_ERROR_TITLE_KEYS[kind]);
}

export function walletAdjustmentFlowErrorTone(kind: WalletAdjustmentFlowErrorKind): Exclude<Tone, "neutral"> {
  return FLOW_ERROR_TONES[kind];
}
