import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  normalizeProtectionCoverageRejectedV1,
  normalizeProtectionCoverageReservedV1,
  normalizeProtectionCoverageSettledV1,
  platformCoverageFactTypes,
  type ProtectionCoverageRejectedV1Payload,
  type ProtectionCoverageReservedV1Payload,
  type ProtectionCoverageSettledV1Payload,
} from "@chase-sets/event-core/platform-coverage-facts";
import {
  classifyLiabilityFundingKind,
  normalizePlatformCoverageCurrencyCode,
  type CoverageRejectionReasonCode,
} from "@chase-sets/primitives/platform-coverage";
import { moneyToCents } from "@chase-sets/primitives/money";
import {
  addMoney,
  assert,
  assertNever,
  compareMoney,
  ensureIsoTimestamp,
  normalizeMoneyAmount,
  normalizeRequiredText,
  subtractMoney,
} from "../../../support/runtime-support/common";

/**
 * ProtectionCoverage — the Settlement-owned reservation aggregate for
 * platform-covered support resolutions (ADR 0022).
 *
 * Settlement owns financial truth (ADR 0013/0020, reaffirmed by ADR 0022). This
 * aggregate is the authoritative accounting for the protection reserve: it
 * reserves the platform-funded portion of a remedy against available protection
 * funds, consumes exactly that portion when the correlated refund settles, and
 * releases the reservation for remedies that never refund. It emits the ratified
 * `settlement.protection-coverage.{reserved,rejected,settled}.v1` facts (their
 * payloads are validated through the merged contract normalizers, so replay and
 * publish are byte-identical) plus internal `released`/`expired` events that are
 * not cross-context facts but keep the availability ledger correct.
 *
 * Concurrency model — one event-sourced stream per currency pool
 * (`settlement.protection-reserve-{currencyCode}`). Every reservation, settlement,
 * and release for a currency folds into one stream, so the event store's
 * optimistic concurrency serializes competing reservations: two approvals that
 * would each fit the reserve in isolation cannot both commit, because the loser
 * retries against the winner's now-reduced availability. No advisory lock or
 * ambient balance read is trusted for the invariant; availability is derived from
 * the pool's own replayed state plus the funded ceiling snapshotted onto the
 * command.
 *
 * Availability = fundedAmount − outstandingReserved − consumed. A reserved
 * coverage subtracts while `reserved`; on settle it moves to `consumed` (still
 * subtracted, now permanently); on release/expire it leaves both totals and the
 * funds return to available. Funded (contributions − reversals) stays owned by the
 * existing contribution read model — it is never turned into a transactional
 * aggregate; the runtime snapshots it onto the reserve command.
 */

export const protectionCoverageInternalEventTypes = {
  released: "settlement.protection-coverage.released.v1",
  expired: "settlement.protection-coverage.expired.v1",
} as const;

/** Why a reservation was released without ever consuming the reserve. */
export const coverageReleaseReasons = ["operator-release", "superseded", "case-cancelled"] as const;
export type CoverageReleaseReason = (typeof coverageReleaseReasons)[number];

export function isCoverageReleaseReason(value: string): value is CoverageReleaseReason {
  return (coverageReleaseReasons as readonly string[]).includes(value);
}

export type CoverageReservationStatus = "reserved" | "settled" | "released" | "expired";

export type CoverageReservationRecord = Readonly<{
  coverageId: string;
  remedyId: string;
  supportRequestId: string;
  reservedAmount: string;
  currencyCode: string;
  policyVersion: string;
  status: CoverageReservationStatus;
  /** "0.00" until settled, then exactly the consumed platform-funded amount. */
  consumedAmount: string;
  refundId: string | null;
  reservedAt: string;
  terminalAt: string | null;
}>;

export type ProtectionRecoveryRecord = Readonly<{
  recoveryId: string;
  coverageId: string;
  remedyId: string;
  recoveredItemId: string;
  returnShipmentId: string;
  recoveryType: "resale-proceeds" | "liquidation-proceeds" | "carrier-claim" | "postage-refund" | "disposition-cost";
  grossAmount: string;
  costAmount: string;
  netAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  occurredAt: string;
}>;

export type ProtectionReserveState = Readonly<{
  currencyCode: string | null;
  /** Sum of reservedAmount across reservations still in `reserved`. */
  outstandingReservedAmount: string;
  /** Sum of consumedAmount across settled reservations. */
  consumedAmount: string;
  /** Sum of reservedAmount across released/expired reservations (metrics only). */
  releasedAmount: string;
  /** Gross disposition proceeds and claims attributed back to settled coverage. */
  recoveredGrossAmount: string;
  /** Fulfillment/disposition costs attributed to recovered value. */
  recoveryCostAmount: string;
  /** Gross minus cost; this replenishes (or reduces) protection-pool availability. */
  recoveredNetAmount: string;
  reservations: Readonly<Record<string, CoverageReservationRecord>>;
  recoveryRecords: Readonly<Record<string, ProtectionRecoveryRecord>>;
}>;

export const initialProtectionReserveState: ProtectionReserveState = {
  currencyCode: null,
  outstandingReservedAmount: "0.00",
  consumedAmount: "0.00",
  releasedAmount: "0.00",
  recoveredGrossAmount: "0.00",
  recoveryCostAmount: "0.00",
  recoveredNetAmount: "0.00",
  reservations: {},
  recoveryRecords: {},
};

/**
 * Available protection funds a new reservation may draw against. Derived purely
 * from the pool's replayed reservation ledger and the funded ceiling snapshotted
 * onto the command — never from an ambient, racy balance read.
 */
export function availableProtectionAmount(fundedAmount: string, state: ProtectionReserveState): string {
  return addMoney(
    subtractMoney(subtractMoney(fundedAmount, state.outstandingReservedAmount), state.consumedAmount),
    state.recoveredNetAmount,
  );
}

// -------------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------------

export type ReserveProtectionCoverageCommand = Readonly<{
  type: "ReserveProtectionCoverage";
  coverageId: string;
  remedyId: string;
  supportRequestId: string;
  requestedAmount: string;
  currencyCode: string;
  policyVersion: string;
  reasonCode: string;
  idempotencyKey: string;
  causationId: string | null;
  occurredAt: string;
  /** Net protection pool (contributions − reversals) resolved by the runtime from the contribution read model. */
  fundedAmount: string;
  /** Optional per-remedy policy ceiling; a request above it is rejected `policy-limit-exceeded`. */
  policyLimitAmount?: string | null;
}>;

export type SettleProtectionCoverageCommand = Readonly<{
  type: "SettleProtectionCoverage";
  coverageId: string;
  refundId: string;
  /** The platform-funded portion consumed; must equal the reserved amount. */
  platformFundedAmount: string;
  /** The seller-funded portion of the same refund (never debits the reserve; carried for the fact). */
  sellerFundedAmount: string;
  currencyCode: string;
  policyVersion: string;
  idempotencyKey: string;
  causationId: string | null;
  occurredAt: string;
}>;

export type ReleaseProtectionCoverageCommand = Readonly<{
  type: "ReleaseProtectionCoverage";
  coverageId: string;
  releaseReason: CoverageReleaseReason;
  policyVersion: string;
  idempotencyKey: string;
  causationId: string | null;
  occurredAt: string;
}>;

export type ExpireProtectionCoverageCommand = Readonly<{
  type: "ExpireProtectionCoverage";
  coverageId: string;
  policyVersion: string;
  idempotencyKey: string;
  causationId: string | null;
  /**
   * The explicit policy deadline this expiry enforces. Supplied by the policy
   * clock (reservedAt + policy TTL), never a UI timer; expiry is refused unless
   * it occurs at or after this deadline.
   */
  deadline: string;
  occurredAt: string;
}>;

export type RecordProtectionRecoveryCommand = Readonly<{
  type: "RecordProtectionRecovery";
  coverageId: string;
  remedyId: string;
  recoveredItemId: string;
  returnShipmentId: string;
  recoveryId: string;
  recoveryType: ProtectionRecoveryRecord["recoveryType"];
  grossAmount: string;
  costAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  causationId: string | null;
  occurredAt: string;
}>;

export type ProtectionCoverageCommand =
  | ReserveProtectionCoverageCommand
  | SettleProtectionCoverageCommand
  | ReleaseProtectionCoverageCommand
  | ExpireProtectionCoverageCommand
  | RecordProtectionRecoveryCommand;

// -------------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------------

export type ProtectionCoverageReservedEvent = DomainEvent<
  typeof platformCoverageFactTypes.protectionCoverageReserved,
  ProtectionCoverageReservedV1Payload
>;

export type ProtectionCoverageRejectedEvent = DomainEvent<
  typeof platformCoverageFactTypes.protectionCoverageRejected,
  ProtectionCoverageRejectedV1Payload
>;

export type ProtectionCoverageSettledEvent = DomainEvent<
  typeof platformCoverageFactTypes.protectionCoverageSettled,
  ProtectionCoverageSettledV1Payload
>;

export type ProtectionCoverageTerminationPayload = Readonly<{
  factSchemaVersion: 1;
  supportRequestId: string;
  remedyId: string;
  coverageId: string;
  idempotencyKey: string;
  causationId: string | null;
  policyVersion: string;
  releasedAmount: string;
  currencyCode: string;
  reasonCode: string;
  occurredAt: string;
}>;

export type ProtectionCoverageReleasedEvent = DomainEvent<
  typeof protectionCoverageInternalEventTypes.released,
  ProtectionCoverageTerminationPayload
>;

export type ProtectionCoverageExpiredEvent = DomainEvent<
  typeof protectionCoverageInternalEventTypes.expired,
  ProtectionCoverageTerminationPayload
>;

export type ProtectionCoverageRecoveryPostedEvent = DomainEvent<
  "settlement.protection-coverage.recovery-posted.v1",
  Readonly<{
    factSchemaVersion: 1;
    recoveryId: string;
    coverageId: string;
    remedyId: string;
    recoveredItemId: string;
    returnShipmentId: string;
    recoveryType: ProtectionRecoveryRecord["recoveryType"];
    grossAmount: string;
    costAmount: string;
    netAmount: string;
    currencyCode: string;
    policyVersion: string;
    evidenceReferences: readonly string[];
    causationId: string | null;
    occurredAt: string;
  }>
>;

export type ProtectionCoverageEvent =
  | ProtectionCoverageReservedEvent
  | ProtectionCoverageRejectedEvent
  | ProtectionCoverageSettledEvent
  | ProtectionCoverageReleasedEvent
  | ProtectionCoverageExpiredEvent
  | ProtectionCoverageRecoveryPostedEvent;

// -------------------------------------------------------------------------------------------------
// Decide
// -------------------------------------------------------------------------------------------------

function rejected(
  command: ReserveProtectionCoverageCommand,
  currencyCode: string,
  requestedAmount: string,
  reasonCode: CoverageRejectionReasonCode,
): readonly ProtectionCoverageEvent[] {
  return [
    {
      type: platformCoverageFactTypes.protectionCoverageRejected,
      data: normalizeProtectionCoverageRejectedV1({
        factSchemaVersion: 1,
        supportRequestId: command.supportRequestId,
        remedyId: command.remedyId,
        idempotencyKey: command.idempotencyKey,
        causationId: command.causationId,
        policyVersion: command.policyVersion,
        occurredAt: command.occurredAt,
        coverageId: command.coverageId,
        requestedAmount,
        currencyCode,
        reasonCode,
      }),
    },
  ];
}

function decideReserve(
  state: ProtectionReserveState,
  command: ReserveProtectionCoverageCommand,
): readonly ProtectionCoverageEvent[] {
  const requestedAmount = normalizeMoneyAmount(command.requestedAmount, {
    fieldName: "Protection coverage requested amount",
  });
  const currencyCode = normalizePlatformCoverageCurrencyCode(command.currencyCode);
  const existing = state.reservations[command.coverageId];

  if (existing) {
    // Idempotent retry: same coverage id with identical terms is a no-op regardless
    // of current lifecycle state (reserved/settled/released/expired).
    const sameTerms =
      compareMoney(existing.reservedAmount, requestedAmount) === 0 &&
      existing.currencyCode === currencyCode &&
      existing.remedyId === command.remedyId;
    if (sameTerms) {
      return [];
    }
    // Semantic reuse of a coverage id under different terms is refused and audited.
    return rejected(command, currencyCode, requestedAmount, "conflicting-terms");
  }

  // A coverage id belongs to exactly one currency pool.
  if (state.currencyCode !== null && state.currencyCode !== currencyCode) {
    return rejected(command, currencyCode, requestedAmount, "currency-mismatch");
  }

  if (command.policyLimitAmount != null) {
    const policyLimitAmount = normalizeMoneyAmount(command.policyLimitAmount, {
      fieldName: "Protection coverage policy limit",
      allowZero: true,
    });
    if (compareMoney(requestedAmount, policyLimitAmount) > 0) {
      return rejected(command, currencyCode, requestedAmount, "policy-limit-exceeded");
    }
  }

  const available = availableProtectionAmount(
    normalizeMoneyAmount(command.fundedAmount, { fieldName: "Protection reserve funded amount", allowZero: true }),
    state,
  );
  if (compareMoney(requestedAmount, available) > 0) {
    return rejected(command, currencyCode, requestedAmount, "insufficient-reserve");
  }

  return [
    {
      type: platformCoverageFactTypes.protectionCoverageReserved,
      data: normalizeProtectionCoverageReservedV1({
        factSchemaVersion: 1,
        supportRequestId: command.supportRequestId,
        remedyId: command.remedyId,
        idempotencyKey: command.idempotencyKey,
        causationId: command.causationId,
        policyVersion: command.policyVersion,
        occurredAt: ensureIsoTimestamp(command.occurredAt, "Protection coverage reservation must record a timestamp."),
        coverageId: command.coverageId,
        reservedAmount: requestedAmount,
        currencyCode,
      }),
    },
  ];
}

function decideSettle(
  state: ProtectionReserveState,
  command: SettleProtectionCoverageCommand,
): readonly ProtectionCoverageEvent[] {
  const existing = state.reservations[command.coverageId];
  assert(existing !== undefined, "Cannot settle protection coverage that was never reserved.");

  if (existing.status === "settled") {
    // Exactly-once consumption: a redelivered settle for the same coverage is a no-op.
    assert(
      existing.refundId === command.refundId,
      "Protection coverage is already settled against a different refund.",
    );
    return [];
  }
  assert(
    existing.status === "reserved",
    "Only a reserved protection coverage can be settled; it was released or expired.",
  );

  const currencyCode = normalizePlatformCoverageCurrencyCode(command.currencyCode);
  assert(currencyCode === existing.currencyCode, "Settlement currency must match the reserved currency.");

  const platformFundedAmount = normalizeMoneyAmount(command.platformFundedAmount, {
    fieldName: "Settled platform-funded amount",
  });
  const sellerFundedAmount = normalizeMoneyAmount(command.sellerFundedAmount, {
    fieldName: "Settled seller-funded amount",
    allowZero: true,
  });
  // The reservation held exactly the platform-funded portion; consumption equals it.
  // Consuming more than reserved would overdraw; consuming less would strand reserve.
  assert(
    compareMoney(platformFundedAmount, existing.reservedAmount) === 0,
    "Settled platform-funded amount must equal the reserved amount.",
  );

  const fundingKind = classifyLiabilityFundingKind(
    moneyToCents(sellerFundedAmount),
    moneyToCents(platformFundedAmount),
  );

  return [
    {
      type: platformCoverageFactTypes.protectionCoverageSettled,
      data: normalizeProtectionCoverageSettledV1({
        factSchemaVersion: 1,
        supportRequestId: existing.supportRequestId,
        remedyId: existing.remedyId,
        idempotencyKey: command.idempotencyKey,
        causationId: command.causationId,
        policyVersion: command.policyVersion,
        occurredAt: ensureIsoTimestamp(command.occurredAt, "Protection coverage settlement must record a timestamp."),
        coverageId: command.coverageId,
        refundId: command.refundId,
        allocation: {
          sellerFundedAmount,
          platformFundedAmount,
          currencyCode,
          fundingKind,
        },
        currencyCode,
      }),
    },
  ];
}

function decideTerminate(
  state: ProtectionReserveState,
  command: ReleaseProtectionCoverageCommand | ExpireProtectionCoverageCommand,
): readonly ProtectionCoverageEvent[] {
  const isExpiry = command.type === "ExpireProtectionCoverage";
  const existing = state.reservations[command.coverageId];
  assert(existing !== undefined, "Cannot release protection coverage that was never reserved.");

  const terminalStatus: CoverageReservationStatus = isExpiry ? "expired" : "released";
  if (existing.status === terminalStatus) {
    // Release/expire exactly once.
    return [];
  }
  assert(
    existing.status === "reserved",
    isExpiry
      ? "Only a reserved protection coverage can expire; it was settled or released."
      : "Only a reserved protection coverage can be released; it was settled or expired.",
  );

  if (command.type === "ExpireProtectionCoverage") {
    const deadline = ensureIsoTimestamp(command.deadline, "Protection coverage expiry must carry a policy deadline.");
    assert(
      Date.parse(command.occurredAt) >= Date.parse(deadline),
      "Protection coverage cannot expire before its policy deadline.",
    );
  }

  const reasonCode: string = isExpiry ? "coverage-expired" : command.releaseReason;
  const occurredAt = ensureIsoTimestamp(command.occurredAt, "Protection coverage release must record a timestamp.");
  const payload: ProtectionCoverageTerminationPayload = {
    factSchemaVersion: 1,
    supportRequestId: existing.supportRequestId,
    remedyId: existing.remedyId,
    coverageId: existing.coverageId,
    idempotencyKey: command.idempotencyKey,
    causationId: command.causationId,
    policyVersion: command.policyVersion,
    releasedAmount: existing.reservedAmount,
    currencyCode: existing.currencyCode,
    reasonCode,
    occurredAt,
  };

  return [
    {
      type: isExpiry ? protectionCoverageInternalEventTypes.expired : protectionCoverageInternalEventTypes.released,
      data: payload,
    } as ProtectionCoverageEvent,
  ];
}

function decideRecovery(
  state: ProtectionReserveState,
  command: RecordProtectionRecoveryCommand,
): readonly ProtectionCoverageEvent[] {
  const grossAmount = normalizeMoneyAmount(command.grossAmount, {
    fieldName: "Recovered gross amount",
    allowZero: true,
  });
  const costAmount = normalizeMoneyAmount(command.costAmount, {
    fieldName: "Recovered disposition cost",
    allowZero: true,
  });
  assert(grossAmount !== "0.00" || costAmount !== "0.00", "A protection recovery posting cannot be zero.");
  const currencyCode = normalizePlatformCoverageCurrencyCode(command.currencyCode);
  const existingRecovery = state.recoveryRecords[command.recoveryId];
  if (existingRecovery) {
    assert(
      existingRecovery.coverageId === command.coverageId &&
        existingRecovery.recoveryType === command.recoveryType &&
        existingRecovery.grossAmount === grossAmount &&
        existingRecovery.costAmount === costAmount &&
        existingRecovery.currencyCode === currencyCode,
      "Recovery id was reused with different value terms.",
    );
    return [];
  }

  const coverage = state.reservations[command.coverageId];
  assert(coverage?.status === "settled", "Recovered value can only reconcile to settled coverage.");
  assert(coverage.remedyId === command.remedyId, "Recovered value must match the originating remedy.");
  assert(coverage.currencyCode === currencyCode, "Recovered value currency must match the originating coverage.");
  assert(
    ["resale-proceeds", "liquidation-proceeds", "carrier-claim", "postage-refund", "disposition-cost"].includes(
      command.recoveryType,
    ),
    "Unsupported protection recovery type.",
  );
  const evidenceReferences = [...new Set(command.evidenceReferences.map((value) => value.trim()).filter(Boolean))];
  assert(evidenceReferences.length > 0, "Protection recovery requires evidence.");

  return [
    {
      type: "settlement.protection-coverage.recovery-posted.v1",
      data: {
        factSchemaVersion: 1,
        recoveryId: normalizeRequiredText(command.recoveryId, "Recovery id is required."),
        coverageId: coverage.coverageId,
        remedyId: coverage.remedyId,
        recoveredItemId: normalizeRequiredText(command.recoveredItemId, "Recovered item id is required."),
        returnShipmentId: normalizeRequiredText(command.returnShipmentId, "Return shipment id is required."),
        recoveryType: command.recoveryType,
        grossAmount,
        costAmount,
        netAmount: subtractMoney(grossAmount, costAmount),
        currencyCode,
        policyVersion: normalizeRequiredText(command.policyVersion, "Recovery policy version is required."),
        evidenceReferences,
        causationId: command.causationId,
        occurredAt: ensureIsoTimestamp(command.occurredAt, "Protection recovery must record a timestamp."),
      },
    },
  ];
}

export const decideProtectionCoverage: AggregateDecider<
  ProtectionReserveState,
  ProtectionCoverageCommand,
  ProtectionCoverageEvent
> = (state, command) => {
  switch (command.type) {
    case "ReserveProtectionCoverage":
      return decideReserve(state, command);
    case "SettleProtectionCoverage":
      return decideSettle(state, command);
    case "ReleaseProtectionCoverage":
      if (!isCoverageReleaseReason(command.releaseReason)) {
        throw new Error(`Unknown protection coverage release reason: ${command.releaseReason}`);
      }
      return decideTerminate(state, command);
    case "ExpireProtectionCoverage":
      return decideTerminate(state, command);
    case "RecordProtectionRecovery":
      return decideRecovery(state, command);
    default:
      return assertNever(command);
  }
};

// -------------------------------------------------------------------------------------------------
// Evolve
// -------------------------------------------------------------------------------------------------

export const evolveProtectionCoverage: AggregateEvolver<ProtectionReserveState, ProtectionCoverageEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case platformCoverageFactTypes.protectionCoverageReserved: {
      const data = event.data;
      const record: CoverageReservationRecord = {
        coverageId: data.coverageId,
        remedyId: data.remedyId,
        supportRequestId: data.supportRequestId,
        reservedAmount: data.reservedAmount,
        currencyCode: data.currencyCode,
        policyVersion: data.policyVersion,
        status: "reserved",
        consumedAmount: "0.00",
        refundId: null,
        reservedAt: data.occurredAt,
        terminalAt: null,
      };
      return {
        ...state,
        currencyCode: state.currencyCode ?? data.currencyCode,
        outstandingReservedAmount: addMoney(state.outstandingReservedAmount, data.reservedAmount),
        reservations: { ...state.reservations, [data.coverageId]: record },
      };
    }
    case platformCoverageFactTypes.protectionCoverageRejected:
      // Rejections are audit-only; they never move the availability ledger.
      return state;
    case platformCoverageFactTypes.protectionCoverageSettled: {
      const data = event.data;
      const existing = state.reservations[data.coverageId];
      if (existing === undefined || existing.status !== "reserved") {
        return state;
      }
      const consumed = data.allocation.platformFundedAmount;
      return {
        ...state,
        outstandingReservedAmount: subtractMoney(state.outstandingReservedAmount, existing.reservedAmount),
        consumedAmount: addMoney(state.consumedAmount, consumed),
        reservations: {
          ...state.reservations,
          [data.coverageId]: {
            ...existing,
            status: "settled",
            consumedAmount: consumed,
            refundId: data.refundId,
            terminalAt: data.occurredAt,
          },
        },
      };
    }
    case protectionCoverageInternalEventTypes.released:
    case protectionCoverageInternalEventTypes.expired: {
      const data = event.data;
      const existing = state.reservations[data.coverageId];
      if (existing === undefined || existing.status !== "reserved") {
        return state;
      }
      const terminalStatus: CoverageReservationStatus =
        event.type === protectionCoverageInternalEventTypes.expired ? "expired" : "released";
      return {
        ...state,
        outstandingReservedAmount: subtractMoney(state.outstandingReservedAmount, existing.reservedAmount),
        releasedAmount: addMoney(state.releasedAmount, existing.reservedAmount),
        reservations: {
          ...state.reservations,
          [data.coverageId]: { ...existing, status: terminalStatus, terminalAt: data.occurredAt },
        },
      };
    }
    case "settlement.protection-coverage.recovery-posted.v1": {
      const data = event.data;
      const record: ProtectionRecoveryRecord = {
        recoveryId: data.recoveryId,
        coverageId: data.coverageId,
        remedyId: data.remedyId,
        recoveredItemId: data.recoveredItemId,
        returnShipmentId: data.returnShipmentId,
        recoveryType: data.recoveryType,
        grossAmount: data.grossAmount,
        costAmount: data.costAmount,
        netAmount: data.netAmount,
        currencyCode: data.currencyCode,
        policyVersion: data.policyVersion,
        evidenceReferences: data.evidenceReferences,
        occurredAt: data.occurredAt,
      };
      return {
        ...state,
        recoveredGrossAmount: addMoney(state.recoveredGrossAmount, data.grossAmount),
        recoveryCostAmount: addMoney(state.recoveryCostAmount, data.costAmount),
        recoveredNetAmount: addMoney(state.recoveredNetAmount, data.netAmount),
        recoveryRecords: { ...state.recoveryRecords, [data.recoveryId]: record },
      };
    }
    default:
      return assertNever(event);
  }
};

/** The pool stream id for a currency's protection reserve. One stream per currency serializes reservations. */
export function protectionReserveStreamId(currencyCode: string): string {
  return `settlement.protection-reserve-${normalizePlatformCoverageCurrencyCode(currencyCode)}`;
}
