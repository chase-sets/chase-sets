import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, LedgerEntryId, UserId, WalletAdjustmentId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  compareMoney,
  ensureIsoTimestamp,
  normalizeCurrencyCode,
  normalizeLedgerEntryDirection,
  normalizeMoneyAmount,
  normalizeOptionalText,
  subtractMoney,
  type CurrencyCode,
  type LedgerEntryDirection,
} from "../../../support/runtime-support/common";

/**
 * The closed Wallet Adjustment reason-code taxonomy ratified by
 * ADR 0020 (docs/adr/0020-wallet-adjustment-authority-and-balance-types.md).
 * Extending this set requires a new ADR revision, never an ad hoc string --
 * every code except `other-with-required-detail` carries its meaning without
 * depending on free-text detail.
 */
export const WALLET_ADJUSTMENT_REASON_CODES = [
  "transaction-correction",
  "refund-correction",
  "fee-correction",
  "dispute-resolution",
  "fraud-recovery",
  "support-resolution",
  "legal-obligation",
  "goodwill-cash-credit",
  "operational-error",
  "other-with-required-detail",
] as const;

export type WalletAdjustmentReasonCode = (typeof WALLET_ADJUSTMENT_REASON_CODES)[number];

/** The only reason code that requires a mandatory free-text explanation. */
export const WALLET_ADJUSTMENT_DETAIL_REQUIRED_REASON_CODE: WalletAdjustmentReasonCode = "other-with-required-detail";

export function normalizeWalletAdjustmentReasonCode(value: string): WalletAdjustmentReasonCode {
  const match = WALLET_ADJUSTMENT_REASON_CODES.find((code) => code === value.trim());
  assert(match !== undefined, "Wallet Adjustment reason code is not supported.");
  return match;
}

/**
 * The Settlement-owned control inputs that govern a Wallet Adjustment's
 * approval, snapshotted onto every approval/reversal event so a later policy
 * revision never reinterprets a historical adjustment's authorization basis.
 * The concrete numbers are platform policy owned by the separate controls
 * slice; this shape is the ratified schema and the conservative default below
 * is the compiled fallback used until an operator revises it.
 */
export type WalletAdjustmentControls = Readonly<{
  highValueCreditThresholdAmount: string;
  highValueDebitThresholdAmount: string;
  recentAuthMaxAgeMinutes: number;
}>;

export const WALLET_ADJUSTMENT_CONTROLS_DEFAULT: WalletAdjustmentControls = {
  highValueCreditThresholdAmount: "500.00",
  highValueDebitThresholdAmount: "500.00",
  recentAuthMaxAgeMinutes: 15,
};

export function normalizeWalletAdjustmentControls(controls: WalletAdjustmentControls): WalletAdjustmentControls {
  assert(
    Number.isInteger(controls.recentAuthMaxAgeMinutes) && controls.recentAuthMaxAgeMinutes > 0,
    "Recent-authentication window must be a whole number of minutes greater than zero.",
  );
  return {
    highValueCreditThresholdAmount: normalizeMoneyAmount(controls.highValueCreditThresholdAmount, {
      fieldName: "High-value credit threshold amount",
      allowZero: true,
    }),
    highValueDebitThresholdAmount: normalizeMoneyAmount(controls.highValueDebitThresholdAmount, {
      fieldName: "High-value debit threshold amount",
      allowZero: true,
    }),
    recentAuthMaxAgeMinutes: controls.recentAuthMaxAgeMinutes,
  };
}

/** Why an approval required elevated, separation-of-duties second approval. */
export type WalletAdjustmentElevationReason = "high-value" | "negative-balance" | "reversal-after-settlement";

export type WalletAdjustmentStatus = "requested" | "approved" | "rejected" | "posted" | "reversed";

export type WalletAdjustmentState = Readonly<{
  adjustmentId: WalletAdjustmentId | null;
  status: WalletAdjustmentStatus | null;
  targetAccountId: AccountId | null;
  direction: LedgerEntryDirection | null;
  amount: string | null;
  currencyCode: CurrencyCode | null;
  reasonCode: WalletAdjustmentReasonCode | null;
  explanation: string | null;
  evidenceReferences: readonly string[];
  reversalOfAdjustmentId: WalletAdjustmentId | null;
  requestedBy: UserId | null;
  requestedAt: string | null;
  selfBenefiting: boolean;
  approvedBy: UserId | null;
  approvedAt: string | null;
  controls: WalletAdjustmentControls | null;
  elevationRequired: boolean;
  elevationReasons: readonly WalletAdjustmentElevationReason[];
  elevationApprovedBy: UserId | null;
  createsOrIncreasesNegativeBalance: boolean;
  reversalAfterFundsSettled: boolean;
  rejectedBy: UserId | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  postedLedgerEntryId: LedgerEntryId | null;
  postedAt: string | null;
  availableBalanceBefore: string | null;
  availableBalanceAfter: string | null;
  reversedByAdjustmentId: WalletAdjustmentId | null;
  reversedAt: string | null;
  updatedAt: string | null;
}>;

export const initialWalletAdjustmentState: WalletAdjustmentState = {
  adjustmentId: null,
  status: null,
  targetAccountId: null,
  direction: null,
  amount: null,
  currencyCode: null,
  reasonCode: null,
  explanation: null,
  evidenceReferences: [],
  reversalOfAdjustmentId: null,
  requestedBy: null,
  requestedAt: null,
  selfBenefiting: false,
  approvedBy: null,
  approvedAt: null,
  controls: null,
  elevationRequired: false,
  elevationReasons: [],
  elevationApprovedBy: null,
  createsOrIncreasesNegativeBalance: false,
  reversalAfterFundsSettled: false,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  postedLedgerEntryId: null,
  postedAt: null,
  availableBalanceBefore: null,
  availableBalanceAfter: null,
  reversedByAdjustmentId: null,
  reversedAt: null,
  updatedAt: null,
};

export type RequestWalletAdjustmentCommand = Readonly<{
  type: "RequestWalletAdjustment";
  adjustmentId: WalletAdjustmentId;
  targetAccountId: AccountId;
  direction: LedgerEntryDirection;
  amount: string;
  currencyCode: CurrencyCode;
  reasonCode: WalletAdjustmentReasonCode;
  explanation?: string | null;
  evidenceReferences?: readonly string[];
  requestedBy: UserId;
  requestedAt: string;
  selfBenefiting: boolean;
  reversalOfAdjustmentId?: WalletAdjustmentId | null;
}>;

export type ApproveWalletAdjustmentCommand = Readonly<{
  type: "ApproveWalletAdjustment";
  approvedBy: UserId;
  approvedAt: string;
  controls: WalletAdjustmentControls;
  createsOrIncreasesNegativeBalance: boolean;
  reversalAfterFundsSettled: boolean;
  elevationApprovedBy?: UserId | null;
}>;

export type RejectWalletAdjustmentCommand = Readonly<{
  type: "RejectWalletAdjustment";
  rejectedBy: UserId;
  rejectedAt: string;
  rejectionReason?: string | null;
}>;

export type PostWalletAdjustmentCommand = Readonly<{
  type: "PostWalletAdjustment";
  ledgerEntryId: LedgerEntryId;
  postedAt: string;
  availableBalanceBefore: string;
  availableBalanceAfter: string;
}>;

export type ReverseWalletAdjustmentCommand = Readonly<{
  type: "ReverseWalletAdjustment";
  reversalAdjustmentId: WalletAdjustmentId;
  reversedBy: UserId;
  reversedAt: string;
}>;

export type WalletAdjustmentCommand =
  | RequestWalletAdjustmentCommand
  | ApproveWalletAdjustmentCommand
  | RejectWalletAdjustmentCommand
  | PostWalletAdjustmentCommand
  | ReverseWalletAdjustmentCommand;

export type WalletAdjustmentRequestedEvent = DomainEvent<
  "settlement.wallet-adjustment.requested",
  Readonly<{
    adjustmentId: WalletAdjustmentId;
    targetAccountId: AccountId;
    direction: LedgerEntryDirection;
    amount: string;
    currencyCode: CurrencyCode;
    reasonCode: WalletAdjustmentReasonCode;
    explanation: string | null;
    evidenceReferences: readonly string[];
    reversalOfAdjustmentId: WalletAdjustmentId | null;
    requestedBy: UserId;
    requestedAt: string;
    selfBenefiting: boolean;
  }>
>;

export type WalletAdjustmentApprovedEvent = DomainEvent<
  "settlement.wallet-adjustment.approved",
  Readonly<{
    adjustmentId: WalletAdjustmentId;
    approvedBy: UserId;
    approvedAt: string;
    controls: WalletAdjustmentControls;
    elevationRequired: boolean;
    elevationReasons: readonly WalletAdjustmentElevationReason[];
    elevationApprovedBy: UserId | null;
    createsOrIncreasesNegativeBalance: boolean;
    reversalAfterFundsSettled: boolean;
  }>
>;

export type WalletAdjustmentRejectedEvent = DomainEvent<
  "settlement.wallet-adjustment.rejected",
  Readonly<{
    adjustmentId: WalletAdjustmentId;
    rejectedBy: UserId;
    rejectedAt: string;
    rejectionReason: string | null;
  }>
>;

export type WalletAdjustmentPostedEvent = DomainEvent<
  "settlement.wallet-adjustment.posted",
  Readonly<{
    adjustmentId: WalletAdjustmentId;
    ledgerEntryId: LedgerEntryId;
    postedAt: string;
    availableBalanceBefore: string;
    availableBalanceAfter: string;
  }>
>;

export type WalletAdjustmentReversedEvent = DomainEvent<
  "settlement.wallet-adjustment.reversed",
  Readonly<{
    adjustmentId: WalletAdjustmentId;
    reversalAdjustmentId: WalletAdjustmentId;
    reversedBy: UserId;
    reversedAt: string;
  }>
>;

export type WalletAdjustmentEvent =
  | WalletAdjustmentRequestedEvent
  | WalletAdjustmentApprovedEvent
  | WalletAdjustmentRejectedEvent
  | WalletAdjustmentPostedEvent
  | WalletAdjustmentReversedEvent;

function isHighValue(direction: LedgerEntryDirection, amount: string, controls: WalletAdjustmentControls): boolean {
  const threshold =
    direction === "credit" ? controls.highValueCreditThresholdAmount : controls.highValueDebitThresholdAmount;
  return compareMoney(amount, threshold) >= 0;
}

function resolveElevation(
  state: WalletAdjustmentState,
  command: ApproveWalletAdjustmentCommand,
  controls: WalletAdjustmentControls,
): Readonly<{ required: boolean; reasons: readonly WalletAdjustmentElevationReason[] }> {
  const reasons: WalletAdjustmentElevationReason[] = [];
  if (isHighValue(state.direction as LedgerEntryDirection, state.amount as string, controls)) {
    reasons.push("high-value");
  }
  if (command.createsOrIncreasesNegativeBalance) {
    reasons.push("negative-balance");
  }
  if (command.reversalAfterFundsSettled) {
    reasons.push("reversal-after-settlement");
  }
  return { required: reasons.length > 0, reasons };
}

export const decideWalletAdjustment: AggregateDecider<
  WalletAdjustmentState,
  WalletAdjustmentCommand,
  WalletAdjustmentEvent
> = (state, command) => {
  switch (command.type) {
    case "RequestWalletAdjustment": {
      if (state.status !== null) {
        // Idempotent: a re-request of the same deterministic adjustment id is a no-op.
        return [];
      }
      const amount = normalizeMoneyAmount(command.amount, { fieldName: "Wallet Adjustment amount" });
      const currencyCode = normalizeCurrencyCode(command.currencyCode);
      const direction = normalizeLedgerEntryDirection(command.direction);
      const reasonCode = normalizeWalletAdjustmentReasonCode(command.reasonCode);
      const explanation = normalizeOptionalText(command.explanation);
      assert(
        reasonCode !== WALLET_ADJUSTMENT_DETAIL_REQUIRED_REASON_CODE || explanation !== null,
        "Wallet Adjustment reason 'other-with-required-detail' requires a free-text explanation.",
      );
      const evidenceReferences = (command.evidenceReferences ?? [])
        .map((reference) => reference.trim())
        .filter((reference) => reference.length > 0);

      return [
        {
          type: "settlement.wallet-adjustment.requested",
          data: {
            adjustmentId: command.adjustmentId,
            targetAccountId: command.targetAccountId,
            direction,
            amount,
            currencyCode,
            reasonCode,
            explanation,
            evidenceReferences,
            reversalOfAdjustmentId: command.reversalOfAdjustmentId ?? null,
            requestedBy: command.requestedBy,
            requestedAt: ensureIsoTimestamp(command.requestedAt, "Wallet Adjustment request must record a timestamp."),
            selfBenefiting: command.selfBenefiting,
          },
        },
      ];
    }
    case "ApproveWalletAdjustment": {
      assert(state.status !== null, "Wallet Adjustment must be requested before approval.");
      if (state.status === "approved") {
        // Idempotent: the first approval stands.
        return [];
      }
      assert(state.status === "requested", "Only a requested Wallet Adjustment can be approved.");
      assert(command.approvedBy !== state.requestedBy, "A Wallet Adjustment cannot be approved by its requester.");
      assert(!state.selfBenefiting, "A self-benefiting Wallet Adjustment is blocked outright and cannot be approved.");
      const controls = normalizeWalletAdjustmentControls(command.controls);
      const elevation = resolveElevation(state, command, controls);
      if (elevation.required) {
        assert(command.elevationApprovedBy != null, "This Wallet Adjustment requires a second, elevated approval.");
        assert(
          command.elevationApprovedBy !== state.requestedBy && command.elevationApprovedBy !== command.approvedBy,
          "The elevated approver must be distinct from the requester and the primary approver.",
        );
      }

      return [
        {
          type: "settlement.wallet-adjustment.approved",
          data: {
            adjustmentId: state.adjustmentId as WalletAdjustmentId,
            approvedBy: command.approvedBy,
            approvedAt: ensureIsoTimestamp(command.approvedAt, "Wallet Adjustment approval must record a timestamp."),
            controls,
            elevationRequired: elevation.required,
            elevationReasons: elevation.reasons,
            elevationApprovedBy: elevation.required ? (command.elevationApprovedBy ?? null) : null,
            createsOrIncreasesNegativeBalance: command.createsOrIncreasesNegativeBalance,
            reversalAfterFundsSettled: command.reversalAfterFundsSettled,
          },
        },
      ];
    }
    case "RejectWalletAdjustment": {
      assert(state.status !== null, "Wallet Adjustment must be requested before rejection.");
      if (state.status === "rejected") {
        return [];
      }
      assert(state.status === "requested", "Only a requested Wallet Adjustment can be rejected.");
      assert(command.rejectedBy !== state.requestedBy, "A Wallet Adjustment cannot be rejected by its requester.");

      return [
        {
          type: "settlement.wallet-adjustment.rejected",
          data: {
            adjustmentId: state.adjustmentId as WalletAdjustmentId,
            rejectedBy: command.rejectedBy,
            rejectedAt: ensureIsoTimestamp(command.rejectedAt, "Wallet Adjustment rejection must record a timestamp."),
            rejectionReason: normalizeOptionalText(command.rejectionReason),
          },
        },
      ];
    }
    case "PostWalletAdjustment": {
      assert(state.status !== null, "Wallet Adjustment must be requested before posting.");
      if (state.status === "posted") {
        // Idempotent: the approved adjustment posts exactly one ledger entry.
        return [];
      }
      assert(state.status === "approved", "Only an approved Wallet Adjustment can be posted.");

      return [
        {
          type: "settlement.wallet-adjustment.posted",
          data: {
            adjustmentId: state.adjustmentId as WalletAdjustmentId,
            ledgerEntryId: command.ledgerEntryId,
            postedAt: ensureIsoTimestamp(command.postedAt, "Wallet Adjustment posting must record a timestamp."),
            availableBalanceBefore: normalizeSignedBalance(command.availableBalanceBefore),
            availableBalanceAfter: normalizeSignedBalance(command.availableBalanceAfter),
          },
        },
      ];
    }
    case "ReverseWalletAdjustment": {
      assert(state.status !== null, "Wallet Adjustment must be posted before reversal.");
      if (state.status === "reversed") {
        return [];
      }
      assert(state.status === "posted", "Only a posted Wallet Adjustment can be reversed.");

      return [
        {
          type: "settlement.wallet-adjustment.reversed",
          data: {
            adjustmentId: state.adjustmentId as WalletAdjustmentId,
            reversalAdjustmentId: command.reversalAdjustmentId,
            reversedBy: command.reversedBy,
            reversedAt: ensureIsoTimestamp(command.reversedAt, "Wallet Adjustment reversal must record a timestamp."),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

/** A balance snapshot may be negative; validate the numeric shape without forcing positivity. */
function normalizeSignedBalance(value: string): string {
  const amount = value.startsWith("-")
    ? `-${normalizeMoneyAmount(value.slice(1), { fieldName: "Balance amount", allowZero: true })}`
    : normalizeMoneyAmount(value, { fieldName: "Balance amount", allowZero: true });
  // Normalize "-0.00" to "0.00".
  return compareMoney(amount, "0.00") === 0 ? "0.00" : amount;
}

export const evolveWalletAdjustment: AggregateEvolver<WalletAdjustmentState, WalletAdjustmentEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "settlement.wallet-adjustment.requested":
      return {
        ...initialWalletAdjustmentState,
        adjustmentId: event.data.adjustmentId,
        status: "requested",
        targetAccountId: event.data.targetAccountId,
        direction: event.data.direction,
        amount: event.data.amount,
        currencyCode: event.data.currencyCode,
        reasonCode: event.data.reasonCode,
        explanation: event.data.explanation,
        evidenceReferences: event.data.evidenceReferences,
        reversalOfAdjustmentId: event.data.reversalOfAdjustmentId,
        requestedBy: event.data.requestedBy,
        requestedAt: event.data.requestedAt,
        selfBenefiting: event.data.selfBenefiting,
        updatedAt: event.data.requestedAt,
      };
    case "settlement.wallet-adjustment.approved":
      return {
        ...state,
        status: "approved",
        approvedBy: event.data.approvedBy,
        approvedAt: event.data.approvedAt,
        controls: event.data.controls,
        elevationRequired: event.data.elevationRequired,
        elevationReasons: event.data.elevationReasons,
        elevationApprovedBy: event.data.elevationApprovedBy,
        createsOrIncreasesNegativeBalance: event.data.createsOrIncreasesNegativeBalance,
        reversalAfterFundsSettled: event.data.reversalAfterFundsSettled,
        updatedAt: event.data.approvedAt,
      };
    case "settlement.wallet-adjustment.rejected":
      return {
        ...state,
        status: "rejected",
        rejectedBy: event.data.rejectedBy,
        rejectedAt: event.data.rejectedAt,
        rejectionReason: event.data.rejectionReason,
        updatedAt: event.data.rejectedAt,
      };
    case "settlement.wallet-adjustment.posted":
      return {
        ...state,
        status: "posted",
        postedLedgerEntryId: event.data.ledgerEntryId,
        postedAt: event.data.postedAt,
        availableBalanceBefore: event.data.availableBalanceBefore,
        availableBalanceAfter: event.data.availableBalanceAfter,
        updatedAt: event.data.postedAt,
      };
    case "settlement.wallet-adjustment.reversed":
      return {
        ...state,
        status: "reversed",
        reversedByAdjustmentId: event.data.reversalAdjustmentId,
        reversedAt: event.data.reversedAt,
        updatedAt: event.data.reversedAt,
      };
    default:
      return assertNever(event);
  }
};

/** The signed effect an available adjustment posting has on the wallet's available balance. */
export function walletAdjustmentSignedAmount(direction: LedgerEntryDirection, amount: string): string {
  return direction === "credit" ? amount : `-${amount}`;
}

/** Given the available balance after a posting, reconstruct the balance before it. */
export function availableBalanceBeforePosting(
  availableBalanceAfter: string,
  direction: LedgerEntryDirection,
  amount: string,
): string {
  return subtractMoney(availableBalanceAfter, walletAdjustmentSignedAmount(direction, amount));
}
