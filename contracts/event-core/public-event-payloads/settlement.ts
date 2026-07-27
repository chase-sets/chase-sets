// Settlement-owned public event payloads.
import type { AccountId } from "../../primitives/typed-ids";
import type { AccountLinkageClearedPayload, AccountLinkageFlaggedPayload } from "../account-linkage-facts";
import type {
  ProtectionCoverageRejectedV1Payload,
  ProtectionCoverageReservedV1Payload,
  ProtectionCoverageSettledV1Payload,
} from "../platform-coverage-facts";
import type { InventoryRecoveredItemValueReportedPayload } from "./inventory";

export type PayoutReadinessRecordedPayload = Readonly<{
  accountId: AccountId;
  previousStatus?: string;
  status: string;
  missingRequirements: readonly string[];
  advisoryRequirements?: readonly string[];
  disabledReason?: string | null;
  requirementsDeadline?: string | null;
  providerReference: string | null;
  contactEmail?: string | null;
  onboardingStatus?: string;
  transferCapabilityStatus?: string;
  payoutCapabilityStatus?: string;
  payoutDestinationStatus?: string;
  payoutDestinationFingerprint?: string | null;
  payoutDestinationChangedAt?: string | null;
  payoutAccountDashboard?: string;
  lossesCollector?: string;
  feesCollector?: string;
  requirementsCollector?: string;
  recordedAt: string;
}>;

export type SettlementNegativeBalanceEnteredPayload = Readonly<{
  accountId: AccountId;
  balanceAmount: string;
  enteredAt: string;
}>;

export type SettlementNegativeBalanceCollectionsOpenedPayload = Readonly<{
  accountId: AccountId;
  balanceAmount: string;
  negativeSince: string;
  thresholdAmount: string;
  gracePeriodDays: number;
  openedAt: string;
}>;

export type SettlementNegativeBalanceRecoveredPayload = Readonly<{
  accountId: AccountId;
  balanceAmount: string;
  recoveredAt: string;
}>;

export type SettlementProtectionCoverageRecoveryPostedPayload = Readonly<{
  factSchemaVersion: 1;
  recoveryId: string;
  coverageId: string;
  remedyId: string;
  recoveredItemId: string;
  returnShipmentId: string;
  recoveryType: InventoryRecoveredItemValueReportedPayload["recoveryType"];
  grossAmount: string;
  costAmount: string;
  netAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  causationId: string | null;
  occurredAt: string;
}>;

/**
 * Support-safe settlement support-hold lifecycle facts (milestone Dispute & Return
 * Resolution Self-Service). Settlement freezes seller funds while a support case is
 * open and releases them when the case resolves without a refund. These facts let
 * notification routing subscribe to placed/released transitions instead of inferring
 * them from `settlement_support_holds` storage, and they carry only the identifiers
 * needed to route a buyer/seller notice and deep-link the case and order — never a
 * payout ledger internal, a raw provider id, or a customer-sensitive payload.
 */
export type SettlementSupportHoldFactEnvelope = Readonly<{
  factSchemaVersion: 1;
  /** Deterministic settlement hold id, stable across replay and equal to the read-model `hold_id`. */
  holdId: string;
  /** The support case that placed the hold — the notification deep-link anchor. */
  supportRequestId: string;
  /** The order under dispute — routing/order-context anchor. */
  orderId: string;
  /** Buyer routing target for the counterparty notice. */
  buyerAccountId: AccountId;
  /** Seller routing target — the party whose payout is frozen/released. */
  sellerAccountId: AccountId;
  /** Structured dispute flow (e.g. product-damaged); a routing label, not a free-form payload. */
  flowType: string;
  occurredAt: string;
}>;

export type SettlementSupportHoldPlacedPayload = SettlementSupportHoldFactEnvelope;

/** Why a support hold was released back to the seller. A closed vocabulary keeps notification copy exhaustive. */
export type SettlementSupportHoldReleaseReason = "support-resolved" | "support-closed" | "support-cancelled";

/** A support hold released back to the seller — the case ended without consuming the funds. */
export type SettlementSupportHoldReleasedPayload = SettlementSupportHoldFactEnvelope &
  Readonly<{
    releaseReason: SettlementSupportHoldReleaseReason;
  }>;

/**
 * A support hold consumed by a refund resolution — the frozen funds were applied to the
 * buyer's remedy, not returned to the seller. Distinct from `released` so seller-facing
 * copy never says "funds released back to you" when they were spent. The buyer's own
 * refund notice is owned elsewhere; this fact is the terminal lifecycle signal and keeps
 * a later case close from emitting a spurious release.
 */
export type SettlementSupportHoldConsumedPayload = SettlementSupportHoldFactEnvelope &
  Readonly<{
    /** The refund resolution that consumed the hold (e.g. full-refund, return-for-refund). */
    resolutionType: string;
  }>;

export type SettlementEventPayloads = Readonly<{
  "settlement.account-linkage.flagged": AccountLinkageFlaggedPayload;
  "settlement.account-linkage.cleared": AccountLinkageClearedPayload;
  "settlement.payout-readiness.recorded": PayoutReadinessRecordedPayload;
  "settlement.wallet.negative-balance-entered": SettlementNegativeBalanceEnteredPayload;
  "settlement.wallet.negative-balance-collections-opened": SettlementNegativeBalanceCollectionsOpenedPayload;
  "settlement.wallet.negative-balance-recovered": SettlementNegativeBalanceRecoveredPayload;
  // Platform-covered resolution — Settlement owns protection-coverage financial truth (ADR 0022).
  "settlement.protection-coverage.reserved.v1": ProtectionCoverageReservedV1Payload;
  "settlement.protection-coverage.rejected.v1": ProtectionCoverageRejectedV1Payload;
  "settlement.protection-coverage.settled.v1": ProtectionCoverageSettledV1Payload;
  "settlement.protection-coverage.recovery-posted.v1": SettlementProtectionCoverageRecoveryPostedPayload;
  // Support-hold lifecycle facts for dispute notification routing.
  "settlement.support-hold.placed.v1": SettlementSupportHoldPlacedPayload;
  "settlement.support-hold.released.v1": SettlementSupportHoldReleasedPayload;
  "settlement.support-hold.consumed.v1": SettlementSupportHoldConsumedPayload;
}>;
