import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { assertReturnDirective } from "@chase-sets/primitives/platform-coverage";
import type {
  OrderId,
  RemedyId,
  ReturnShipmentId,
  ShipmentId,
  SupportRequestId,
} from "@chase-sets/primitives/typed-ids";
import { normalizeReturnDestinationSnapshot, type ReturnDestinationSnapshot } from "./facility-directory";
import {
  normalizeReturnShipmentFacilityIntake,
  normalizeReturnShipmentIntakeCorrection,
  type ReturnShipmentFacilityIntake,
  type ReturnShipmentIntakeCorrection,
} from "./facility-intake";
export type {
  ReturnIntakeDiscrepancy,
  ReturnIntakeDiscrepancyType,
  ReturnIntakeDisposition,
  ReturnIntakeEvidenceAttachment,
  ReturnIntakePackageCondition,
  ReturnIntakeSealCondition,
  ReturnShipmentFacilityIntake,
  ReturnShipmentIntakeCorrection,
} from "./facility-intake";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  isTerminalReturnShipmentStatus,
  normalizeOptionalCents,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeReturnShipmentCostPayer,
  normalizeReturnShipmentExceptionType,
  normalizeReturnShipmentLabelFailureReason,
  returnShipmentDeliveryStageRank,
  type ReturnShipmentCostPayer,
  type ReturnShipmentExceptionType,
  type ReturnShipmentLabelFailureReason,
  type ReturnShipmentLabelStatus,
  type ReturnShipmentStatus,
} from "./common";

/** Parcel the buyer must send back. Snapshotted so facility-fit is auditable independent of the outbound package. */
export type ReturnShipmentPackageRequirements = Readonly<{
  weightOunces: number;
  lengthInches: number;
  widthInches: number;
  heightInches: number;
}>;

/** One custody/status milestone on the reverse-shipment timeline. */
export type ReturnShipmentMilestone = Readonly<{
  status: ReturnShipmentStatus;
  occurredAt: string;
  detail: string | null;
}>;

export type ReturnShipmentException = Readonly<{
  exceptionType: ReturnShipmentExceptionType;
  notes: string | null;
  raisedAt: string;
}>;

/** Cross-cutting evidence metadata carried on every reverse-shipment fact. The acting operator is the event envelope's audit block, not duplicated here. */
export type ReturnShipmentFactMetadata = Readonly<{
  correlationRemedyId: RemedyId;
  causationId: string | null;
  idempotencyKey: string;
  policyVersion: string;
}>;

export type ReturnShipmentState = Readonly<{
  returnShipmentId: ReturnShipmentId | null;
  remedyId: RemedyId | null;
  supportRequestId: SupportRequestId | null;
  orderId: OrderId | null;
  outboundShipmentId: ShipmentId | null;
  affectedOrderLineIds: readonly string[];
  returnDirective: string | null;
  shipFromSnapshot: AddressSnapshot | null;
  destinationSnapshot: ReturnDestinationSnapshot | null;
  packageRequirements: ReturnShipmentPackageRequirements | null;
  labelStatus: ReturnShipmentLabelStatus | null;
  labelProviderReference: string | null;
  labelDocumentUrl: string | null;
  trackingIdentifier: string | null;
  carrierName: string | null;
  postageProviderName: string | null;
  postageProviderMode: string | null;
  postageProviderShipmentId: string | null;
  postageProviderLabelId: string | null;
  postageAmountCents: number | null;
  estimatedPostageAmountCents: number | null;
  postageCurrency: string | null;
  labelFailureReason: ReturnShipmentLabelFailureReason | null;
  labelFailureDetail: string | null;
  labelRefundStatus: string | null;
  labelRefundReference: string | null;
  costPayer: ReturnShipmentCostPayer | null;
  costAllocationReference: string | null;
  shipByDeadlineAt: string | null;
  returnByDeadlineAt: string | null;
  policyVersion: string | null;
  idempotencyKey: string | null;
  status: ReturnShipmentStatus | null;
  milestones: readonly ReturnShipmentMilestone[];
  exceptions: readonly ReturnShipmentException[];
  currentExceptionType: ReturnShipmentExceptionType | null;
  currentExceptionNotes: string | null;
  requestedAt: string | null;
  labelReadyAt: string | null;
  labelFailedAt: string | null;
  labelVoidedAt: string | null;
  carrierAcceptedAt: string | null;
  deliveredAt: string | null;
  receivedAt: string | null;
  facilityIntake: ReturnShipmentFacilityIntake | null;
  intakeCorrections: readonly ReturnShipmentIntakeCorrection[];
  duplicateIntakeScanCount: number;
  cancelledAt: string | null;
  expiredAt: string | null;
}>;

export const initialReturnShipmentState: ReturnShipmentState = {
  returnShipmentId: null,
  remedyId: null,
  supportRequestId: null,
  orderId: null,
  outboundShipmentId: null,
  affectedOrderLineIds: [],
  returnDirective: null,
  shipFromSnapshot: null,
  destinationSnapshot: null,
  packageRequirements: null,
  labelStatus: null,
  labelProviderReference: null,
  labelDocumentUrl: null,
  trackingIdentifier: null,
  carrierName: null,
  postageProviderName: null,
  postageProviderMode: null,
  postageProviderShipmentId: null,
  postageProviderLabelId: null,
  postageAmountCents: null,
  estimatedPostageAmountCents: null,
  postageCurrency: null,
  labelFailureReason: null,
  labelFailureDetail: null,
  labelRefundStatus: null,
  labelRefundReference: null,
  costPayer: null,
  costAllocationReference: null,
  shipByDeadlineAt: null,
  returnByDeadlineAt: null,
  policyVersion: null,
  idempotencyKey: null,
  status: null,
  milestones: [],
  exceptions: [],
  currentExceptionType: null,
  currentExceptionNotes: null,
  requestedAt: null,
  labelReadyAt: null,
  labelFailedAt: null,
  labelVoidedAt: null,
  carrierAcceptedAt: null,
  deliveredAt: null,
  receivedAt: null,
  facilityIntake: null,
  intakeCorrections: [],
  duplicateIntakeScanCount: 0,
  cancelledAt: null,
  expiredAt: null,
};

// -------------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------------

export type RequestReturnShipmentCommand = Readonly<{
  type: "RequestReturnShipment";
  returnShipmentId: ReturnShipmentId;
  remedyId: RemedyId;
  supportRequestId: SupportRequestId;
  orderId: OrderId;
  outboundShipmentId: ShipmentId;
  affectedOrderLineIds: readonly string[];
  returnDirective: string;
  shipFromSnapshot: AddressSnapshot;
  destinationSnapshot: ReturnDestinationSnapshot;
  packageRequirements: ReturnShipmentPackageRequirements;
  costPayer: string;
  costAllocationReference?: string | null;
  shipByDeadlineAt: string;
  returnByDeadlineAt: string;
  metadata: ReturnShipmentFactMetadata;
  requestedAt: string;
}>;

export type MarkReturnShipmentLabelReadyCommand = Readonly<{
  type: "MarkReturnShipmentLabelReady";
  carrierName: string;
  trackingIdentifier: string;
  labelProviderReference: string;
  labelDocumentUrl: string;
  postageProviderName: string;
  postageProviderMode: string;
  postageProviderShipmentId: string;
  postageProviderLabelId: string;
  postageAmountCents?: number | null;
  estimatedPostageAmountCents?: number | null;
  postageCurrency?: string | null;
  metadata: ReturnShipmentFactMetadata;
  readyAt: string;
}>;

export type RecordReturnShipmentLabelPurchaseFailedCommand = Readonly<{
  type: "RecordReturnShipmentLabelPurchaseFailed";
  failureReason: string;
  failureDetail: string | null;
  postageProviderName?: string | null;
  postageProviderMode?: string | null;
  metadata: ReturnShipmentFactMetadata;
  failedAt: string;
}>;

export type VoidReturnShipmentLabelCommand = Readonly<{
  type: "VoidReturnShipmentLabel";
  refundStatus: string;
  refundReference?: string | null;
  reason?: string | null;
  metadata: ReturnShipmentFactMetadata;
  voidedAt: string;
}>;

export type RecordReturnShipmentCarrierAcceptedCommand = Readonly<{
  type: "RecordReturnShipmentCarrierAccepted";
  detail?: string | null;
  metadata: ReturnShipmentFactMetadata;
  occurredAt: string;
}>;

export type RecordReturnShipmentInTransitCommand = Readonly<{
  type: "RecordReturnShipmentInTransit";
  detail?: string | null;
  metadata: ReturnShipmentFactMetadata;
  occurredAt: string;
}>;

export type RecordReturnShipmentDeliveredCommand = Readonly<{
  type: "RecordReturnShipmentDelivered";
  detail?: string | null;
  metadata: ReturnShipmentFactMetadata;
  occurredAt: string;
}>;

export type CompleteReturnShipmentFacilityIntakeCommand = Readonly<{
  type: "CompleteReturnShipmentFacilityIntake";
  intake: ReturnShipmentFacilityIntake;
  metadata: ReturnShipmentFactMetadata;
}>;

export type CorrectReturnShipmentFacilityIntakeCommand = Readonly<{
  type: "CorrectReturnShipmentFacilityIntake";
  correction: ReturnShipmentIntakeCorrection;
  metadata: ReturnShipmentFactMetadata;
}>;

export type CancelReturnShipmentCommand = Readonly<{
  type: "CancelReturnShipment";
  reason: string | null;
  metadata: ReturnShipmentFactMetadata;
  cancelledAt: string;
}>;

export type ExpireReturnShipmentCommand = Readonly<{
  type: "ExpireReturnShipment";
  reason: string | null;
  metadata: ReturnShipmentFactMetadata;
  expiredAt: string;
}>;

export type RaiseReturnShipmentExceptionCommand = Readonly<{
  type: "RaiseReturnShipmentException";
  exceptionType: string;
  notes: string | null;
  metadata: ReturnShipmentFactMetadata;
  raisedAt: string;
}>;

export type ReturnShipmentCommand =
  | RequestReturnShipmentCommand
  | MarkReturnShipmentLabelReadyCommand
  | RecordReturnShipmentLabelPurchaseFailedCommand
  | VoidReturnShipmentLabelCommand
  | RecordReturnShipmentCarrierAcceptedCommand
  | RecordReturnShipmentInTransitCommand
  | RecordReturnShipmentDeliveredCommand
  | CompleteReturnShipmentFacilityIntakeCommand
  | CorrectReturnShipmentFacilityIntakeCommand
  | CancelReturnShipmentCommand
  | ExpireReturnShipmentCommand
  | RaiseReturnShipmentExceptionCommand;

// -------------------------------------------------------------------------------------------------
// Events — versioned facts (.v1), following the native-event versioning precedent (ADR 0021).
// -------------------------------------------------------------------------------------------------

type ReturnShipmentRequestedV1Data = Readonly<{
  returnShipmentId: ReturnShipmentId;
  remedyId: RemedyId;
  supportRequestId: SupportRequestId;
  orderId: OrderId;
  outboundShipmentId: ShipmentId;
  returnDirective: string;
  shipFromSnapshot: AddressSnapshot;
  destinationSnapshot: ReturnDestinationSnapshot;
  packageRequirements: ReturnShipmentPackageRequirements;
  costPayer: ReturnShipmentCostPayer;
  costAllocationReference: string | null;
  shipByDeadlineAt: string;
  returnByDeadlineAt: string;
  metadata: ReturnShipmentFactMetadata;
  requestedAt: string;
}>;

export type ReturnShipmentRequestedV1Event = DomainEvent<
  "fulfillment.return-shipment.requested.v1",
  ReturnShipmentRequestedV1Data
>;

export type ReturnShipmentRequestedV2Event = DomainEvent<
  "fulfillment.return-shipment.requested.v2",
  ReturnShipmentRequestedV1Data & Readonly<{ affectedOrderLineIds: readonly string[] }>
>;

export type ReturnShipmentRequestedEvent = ReturnShipmentRequestedV1Event | ReturnShipmentRequestedV2Event;

export type ReturnShipmentLabelReadyEvent = DomainEvent<
  "fulfillment.return-shipment.label-ready.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    carrierName: string;
    trackingIdentifier: string;
    labelProviderReference: string;
    labelDocumentUrl: string;
    postageProviderName: string;
    postageProviderMode: string;
    postageProviderShipmentId: string;
    postageProviderLabelId: string;
    postageAmountCents: number | null;
    estimatedPostageAmountCents: number | null;
    postageCurrency: string | null;
    metadata: ReturnShipmentFactMetadata;
    readyAt: string;
  }>
>;

export type ReturnShipmentLabelPurchaseFailedEvent = DomainEvent<
  "fulfillment.return-shipment.label-purchase-failed.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    failureReason: ReturnShipmentLabelFailureReason;
    failureDetail: string | null;
    postageProviderName: string | null;
    postageProviderMode: string | null;
    metadata: ReturnShipmentFactMetadata;
    failedAt: string;
  }>
>;

export type ReturnShipmentLabelVoidedEvent = DomainEvent<
  "fulfillment.return-shipment.label-voided.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    refundStatus: string;
    refundReference: string | null;
    reason: string | null;
    metadata: ReturnShipmentFactMetadata;
    voidedAt: string;
  }>
>;

export type ReturnShipmentCarrierAcceptedEvent = DomainEvent<
  "fulfillment.return-shipment.carrier-accepted.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    detail: string | null;
    metadata: ReturnShipmentFactMetadata;
    occurredAt: string;
  }>
>;

export type ReturnShipmentInTransitRecordedEvent = DomainEvent<
  "fulfillment.return-shipment.in-transit-recorded.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    detail: string | null;
    metadata: ReturnShipmentFactMetadata;
    occurredAt: string;
  }>
>;

export type ReturnShipmentDeliveredEvent = DomainEvent<
  "fulfillment.return-shipment.delivered.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    detail: string | null;
    metadata: ReturnShipmentFactMetadata;
    deliveredAt: string;
  }>
>;

export type ReturnShipmentFacilityIntakeCompletedEvent = DomainEvent<
  "fulfillment.return-shipment.facility-intake-completed.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    remedyId: RemedyId;
    supportRequestId: SupportRequestId;
    intake: ReturnShipmentFacilityIntake;
    metadata: ReturnShipmentFactMetadata;
  }>
>;

export type ReturnShipmentFacilityIntakeCorrectedEvent = DomainEvent<
  "fulfillment.return-shipment.facility-intake-corrected.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    correction: ReturnShipmentIntakeCorrection;
    metadata: ReturnShipmentFactMetadata;
  }>
>;

export type ReturnShipmentDuplicateIntakeScanObservedEvent = DomainEvent<
  "fulfillment.return-shipment.duplicate-intake-scan-observed.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    facilityId: string;
    operatorUserId: string;
    observedAt: string;
    metadata: ReturnShipmentFactMetadata;
  }>
>;

export type ReturnShipmentCancelledEvent = DomainEvent<
  "fulfillment.return-shipment.cancelled.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    reason: string | null;
    metadata: ReturnShipmentFactMetadata;
    cancelledAt: string;
  }>
>;

export type ReturnShipmentExpiredEvent = DomainEvent<
  "fulfillment.return-shipment.expired.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    reason: string | null;
    metadata: ReturnShipmentFactMetadata;
    expiredAt: string;
  }>
>;

export type ReturnShipmentExceptionRaisedEvent = DomainEvent<
  "fulfillment.return-shipment.exception-raised.v1",
  Readonly<{
    returnShipmentId: ReturnShipmentId;
    exceptionType: ReturnShipmentExceptionType;
    notes: string | null;
    metadata: ReturnShipmentFactMetadata;
    raisedAt: string;
  }>
>;

export type ReturnShipmentEvent =
  | ReturnShipmentRequestedEvent
  | ReturnShipmentLabelReadyEvent
  | ReturnShipmentLabelPurchaseFailedEvent
  | ReturnShipmentLabelVoidedEvent
  | ReturnShipmentCarrierAcceptedEvent
  | ReturnShipmentInTransitRecordedEvent
  | ReturnShipmentDeliveredEvent
  | ReturnShipmentFacilityIntakeCompletedEvent
  | ReturnShipmentFacilityIntakeCorrectedEvent
  | ReturnShipmentDuplicateIntakeScanObservedEvent
  | ReturnShipmentCancelledEvent
  | ReturnShipmentExpiredEvent
  | ReturnShipmentExceptionRaisedEvent;

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

function ensureNonNegativeNumber(value: number, message: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, message);
  return value;
}

function normalizePackageRequirements(input: ReturnShipmentPackageRequirements): ReturnShipmentPackageRequirements {
  return {
    weightOunces: ensureNonNegativeNumber(input.weightOunces, "Return package weight must be a positive number."),
    lengthInches: ensureNonNegativeNumber(input.lengthInches, "Return package length must be a positive number."),
    widthInches: ensureNonNegativeNumber(input.widthInches, "Return package width must be a positive number."),
    heightInches: ensureNonNegativeNumber(input.heightInches, "Return package height must be a positive number."),
  };
}

function normalizeMetadata(remedyId: RemedyId, input: ReturnShipmentFactMetadata): ReturnShipmentFactMetadata {
  assert(input.correlationRemedyId === remedyId, "Fact metadata must correlate to the return shipment's remedy.");
  return {
    correlationRemedyId: remedyId,
    causationId:
      input.causationId == null
        ? null
        : normalizeRequiredText(input.causationId, "Causation id must be non-empty when present."),
    idempotencyKey: normalizeRequiredText(input.idempotencyKey, "Fact metadata requires an idempotency key."),
    policyVersion: normalizeRequiredText(input.policyVersion, "Fact metadata requires a policy version."),
  };
}

function normalizeAffectedOrderLineIds(input: readonly string[]): readonly string[] {
  assert(input.length > 0, "A return shipment must reference at least one affected order line.");
  const normalized = input.map((lineId) => lineId.trim());
  assert(
    normalized.every((lineId) => lineId.length > 0),
    "Affected order line ids must not be empty.",
  );
  assert(new Set(normalized).size === normalized.length, "An affected order line id is duplicated.");
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * A carrier milestone only advances the recorded status when its target stage is
 * strictly ahead of the furthest stage already reached. This makes duplicate and
 * out-of-order carrier scans converge without regressing custody state.
 */
function shouldAdvanceTo(state: ReturnShipmentState, target: ReturnShipmentStatus): boolean {
  return returnShipmentDeliveryStageRank(target) > returnShipmentDeliveryStageRank(state.status);
}

function assertActiveForMilestone(state: ReturnShipmentState): void {
  assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
  assert(state.remedyId !== null, "Return shipment must reference a remedy.");
  assert(
    state.status !== "cancelled" && state.status !== "expired",
    "A cancelled or expired return shipment cannot record carrier milestones.",
  );
}

// -------------------------------------------------------------------------------------------------
// Decider
// -------------------------------------------------------------------------------------------------

export const decideReturnShipment: AggregateDecider<ReturnShipmentState, ReturnShipmentCommand, ReturnShipmentEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "RequestReturnShipment": {
      const returnDirective = assertReturnDirective(command.returnDirective);
      assert(
        returnDirective === "return-to-platform",
        "A ReturnShipment models a buyer-to-platform reverse movement; its directive must be return-to-platform.",
      );
      const affectedOrderLineIds = normalizeAffectedOrderLineIds(command.affectedOrderLineIds);
      if (state.returnShipmentId !== null) {
        // Creation replay is a no-op only when the complete immutable source linkage agrees.
        assert(
          state.remedyId === command.remedyId &&
            state.supportRequestId === command.supportRequestId &&
            state.orderId === command.orderId &&
            state.outboundShipmentId === command.outboundShipmentId &&
            sameStrings(state.affectedOrderLineIds, affectedOrderLineIds) &&
            state.returnDirective === returnDirective,
          "Return shipment already exists with different support, order, shipment, line, remedy, or directive linkage.",
        );
        return [];
      }
      const metadata = normalizeMetadata(command.remedyId, command.metadata);
      const requestedAt = ensureIsoTimestamp(command.requestedAt, "Return shipment request must record a timestamp.");
      const shipByDeadlineAt = ensureIsoTimestamp(command.shipByDeadlineAt, "Ship-by deadline must be a timestamp.");
      const returnByDeadlineAt = ensureIsoTimestamp(
        command.returnByDeadlineAt,
        "Return-by deadline must be a timestamp.",
      );
      assert(
        Date.parse(returnByDeadlineAt) >= Date.parse(shipByDeadlineAt),
        "Return-by deadline cannot precede the ship-by deadline.",
      );
      return [
        {
          type: "fulfillment.return-shipment.requested.v2",
          data: {
            returnShipmentId: command.returnShipmentId,
            remedyId: command.remedyId,
            supportRequestId: command.supportRequestId,
            orderId: command.orderId,
            outboundShipmentId: command.outboundShipmentId,
            affectedOrderLineIds,
            returnDirective,
            shipFromSnapshot: normalizeAddressSnapshot(command.shipFromSnapshot, "Return ship-from"),
            destinationSnapshot: normalizeReturnDestinationSnapshot(command.destinationSnapshot),
            packageRequirements: normalizePackageRequirements(command.packageRequirements),
            costPayer: normalizeReturnShipmentCostPayer(command.costPayer),
            costAllocationReference: normalizeOptionalText(command.costAllocationReference),
            shipByDeadlineAt,
            returnByDeadlineAt,
            metadata,
            requestedAt,
          },
        },
      ];
    }
    case "MarkReturnShipmentLabelReady": {
      assertActiveForMilestone(state);
      if (state.labelStatus === "ready" && state.status !== "requested") {
        return [];
      }
      assert(state.status === "requested", "Only a requested return shipment can become ready to ship.");
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.label-ready.v1",
          data: {
            returnShipmentId: state.returnShipmentId!,
            carrierName: normalizeRequiredText(command.carrierName, "Carrier name is required."),
            trackingIdentifier: normalizeRequiredText(command.trackingIdentifier, "Tracking identifier is required."),
            labelProviderReference: normalizeRequiredText(
              command.labelProviderReference,
              "Label provider reference is required.",
            ),
            labelDocumentUrl: normalizeRequiredText(
              command.labelDocumentUrl,
              "Customer-safe label document URL is required.",
            ),
            postageProviderName: normalizeRequiredText(
              command.postageProviderName,
              "Postage provider name is required.",
            ),
            postageProviderMode: normalizeRequiredText(
              command.postageProviderMode,
              "Postage provider mode is required.",
            ),
            postageProviderShipmentId: normalizeRequiredText(
              command.postageProviderShipmentId,
              "Postage provider shipment id is required.",
            ),
            postageProviderLabelId: normalizeRequiredText(
              command.postageProviderLabelId,
              "Postage provider label id is required.",
            ),
            postageAmountCents: normalizeOptionalCents(
              command.postageAmountCents,
              "Actual postage cost must be a non-negative integer number of cents.",
            ),
            estimatedPostageAmountCents: normalizeOptionalCents(
              command.estimatedPostageAmountCents,
              "Estimated postage cost must be a non-negative integer number of cents.",
            ),
            postageCurrency: normalizeOptionalText(command.postageCurrency),
            metadata,
            readyAt: ensureIsoTimestamp(command.readyAt, "Label readiness must record a timestamp."),
          },
        },
      ];
    }
    case "RecordReturnShipmentLabelPurchaseFailed": {
      assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
      assert(state.remedyId !== null, "Return shipment must reference a remedy.");
      // A failure fact is only meaningful while a label is still being sought: once
      // a label is ready or voided, or the shipment has left the requested stage, a
      // purchase failure cannot apply. Retried purchases record a fresh failure each
      // time, so Support sees every actionable attempt.
      assert(
        state.status === "requested" && state.labelStatus !== "ready" && state.labelStatus !== "voided",
        "A return label purchase failure can only be recorded while the shipment is awaiting a label.",
      );
      const metadata = normalizeMetadata(state.remedyId, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.label-purchase-failed.v1",
          data: {
            returnShipmentId: state.returnShipmentId,
            failureReason: normalizeReturnShipmentLabelFailureReason(command.failureReason),
            failureDetail: normalizeOptionalText(command.failureDetail),
            postageProviderName: normalizeOptionalText(command.postageProviderName),
            postageProviderMode: normalizeOptionalText(command.postageProviderMode),
            metadata,
            failedAt: ensureIsoTimestamp(command.failedAt, "Label purchase failure must record a timestamp."),
          },
        },
      ];
    }
    case "VoidReturnShipmentLabel": {
      assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
      assert(state.remedyId !== null, "Return shipment must reference a remedy.");
      if (state.labelStatus === "voided") {
        // Voiding an already-voided label is a no-op so provider retries and
        // reconciliation sweeps cannot emit a second refund fact.
        return [];
      }
      assert(state.labelStatus === "ready", "Only a purchased return label can be voided.");
      assert(
        returnShipmentDeliveryStageRank(state.status) < returnShipmentDeliveryStageRank("carrier-accepted"),
        "A return label already in carrier custody cannot be voided.",
      );
      const metadata = normalizeMetadata(state.remedyId, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.label-voided.v1",
          data: {
            returnShipmentId: state.returnShipmentId,
            refundStatus: normalizeRequiredText(
              command.refundStatus,
              "Label void must record a provider refund status.",
            ),
            refundReference: normalizeOptionalText(command.refundReference),
            reason: normalizeOptionalText(command.reason),
            metadata,
            voidedAt: ensureIsoTimestamp(command.voidedAt, "Label void must record a timestamp."),
          },
        },
      ];
    }
    case "RecordReturnShipmentCarrierAccepted": {
      assertActiveForMilestone(state);
      if (!shouldAdvanceTo(state, "carrier-accepted")) {
        return [];
      }
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.carrier-accepted.v1",
          data: {
            returnShipmentId: state.returnShipmentId!,
            detail: normalizeOptionalText(command.detail),
            metadata,
            occurredAt: ensureIsoTimestamp(command.occurredAt, "Carrier acceptance must record a timestamp."),
          },
        },
      ];
    }
    case "RecordReturnShipmentInTransit": {
      assertActiveForMilestone(state);
      if (!shouldAdvanceTo(state, "in-transit")) {
        return [];
      }
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.in-transit-recorded.v1",
          data: {
            returnShipmentId: state.returnShipmentId!,
            detail: normalizeOptionalText(command.detail),
            metadata,
            occurredAt: ensureIsoTimestamp(command.occurredAt, "In-transit scan must record a timestamp."),
          },
        },
      ];
    }
    case "RecordReturnShipmentDelivered": {
      assertActiveForMilestone(state);
      if (!shouldAdvanceTo(state, "delivered")) {
        return [];
      }
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.delivered.v1",
          data: {
            returnShipmentId: state.returnShipmentId!,
            detail: normalizeOptionalText(command.detail),
            metadata,
            deliveredAt: ensureIsoTimestamp(command.occurredAt, "Delivery must record a timestamp."),
          },
        },
      ];
    }
    case "CompleteReturnShipmentFacilityIntake": {
      assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
      assert(state.remedyId !== null, "Return shipment must reference a remedy.");
      const intake = normalizeReturnShipmentFacilityIntake(command.intake);
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      assert(
        intake.facilityId === state.destinationSnapshot?.facilityId,
        "This return shipment is assigned to a different facility.",
      );
      if (!shouldAdvanceTo(state, "received")) {
        return [
          {
            type: "fulfillment.return-shipment.duplicate-intake-scan-observed.v1",
            data: {
              returnShipmentId: state.returnShipmentId!,
              facilityId: intake.facilityId,
              operatorUserId: intake.operatorUserId,
              observedAt: intake.receivedAt,
              metadata,
            },
          },
        ];
      }
      const completion: ReturnShipmentFacilityIntakeCompletedEvent = {
        type: "fulfillment.return-shipment.facility-intake-completed.v1",
        data: {
          returnShipmentId: state.returnShipmentId,
          remedyId: state.remedyId,
          supportRequestId: state.supportRequestId!,
          intake,
          metadata,
        },
      };
      if (state.status !== "cancelled" && state.status !== "expired") {
        return [completion];
      }
      assert(
        intake.disposition !== "completed",
        "A package received after cancellation or expiry must route to quarantine or manual review.",
      );
      return [
        completion,
        {
          type: "fulfillment.return-shipment.exception-raised.v1",
          data: {
            returnShipmentId: state.returnShipmentId,
            exceptionType: "other",
            notes: `Package physically received after the Return Shipment was ${state.status}.`,
            metadata,
            raisedAt: intake.receivedAt,
          },
        },
      ];
    }
    case "CorrectReturnShipmentFacilityIntake": {
      assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
      assert(state.facilityIntake !== null, "Facility intake must be completed before it can be corrected.");
      const correction = normalizeReturnShipmentIntakeCorrection(command.correction);
      assert(
        Date.parse(correction.correctedAt) >= Date.parse(state.facilityIntake.receivedAt),
        "An intake correction cannot predate intake completion.",
      );
      return [
        {
          type: "fulfillment.return-shipment.facility-intake-corrected.v1",
          data: {
            returnShipmentId: state.returnShipmentId,
            correction,
            metadata: normalizeMetadata(state.remedyId!, command.metadata),
          },
        },
      ];
    }
    case "CancelReturnShipment": {
      assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
      if (state.status === "cancelled") {
        return [];
      }
      assert(
        state.status === "requested" || state.status === "ready-to-ship",
        "Only a return shipment that is not yet in carrier custody can be cancelled.",
      );
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.cancelled.v1",
          data: {
            returnShipmentId: state.returnShipmentId!,
            reason: normalizeOptionalText(command.reason),
            metadata,
            cancelledAt: ensureIsoTimestamp(command.cancelledAt, "Cancellation must record a timestamp."),
          },
        },
      ];
    }
    case "ExpireReturnShipment": {
      assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
      if (state.status === "expired") {
        return [];
      }
      assert(
        state.status === "requested" || state.status === "ready-to-ship",
        "Only a return shipment that never entered carrier custody can expire.",
      );
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.expired.v1",
          data: {
            returnShipmentId: state.returnShipmentId!,
            reason: normalizeOptionalText(command.reason),
            metadata,
            expiredAt: ensureIsoTimestamp(command.expiredAt, "Expiry must record a timestamp."),
          },
        },
      ];
    }
    case "RaiseReturnShipmentException": {
      assert(state.returnShipmentId !== null, "Return shipment must be requested first.");
      assert(
        !isTerminalReturnShipmentStatus(state.status),
        "A received, cancelled, or expired return shipment cannot raise an exception.",
      );
      const metadata = normalizeMetadata(state.remedyId!, command.metadata);
      return [
        {
          type: "fulfillment.return-shipment.exception-raised.v1",
          data: {
            returnShipmentId: state.returnShipmentId!,
            exceptionType: normalizeReturnShipmentExceptionType(command.exceptionType),
            notes: normalizeOptionalText(command.notes),
            metadata,
            raisedAt: ensureIsoTimestamp(command.raisedAt, "Exception must record a timestamp."),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

// -------------------------------------------------------------------------------------------------
// Evolver
// -------------------------------------------------------------------------------------------------

function withMilestone(
  state: ReturnShipmentState,
  status: ReturnShipmentStatus,
  occurredAt: string,
  detail: string | null,
): readonly ReturnShipmentMilestone[] {
  return [...state.milestones, { status, occurredAt, detail }];
}

export const evolveReturnShipment: AggregateEvolver<ReturnShipmentState, ReturnShipmentEvent> = (state, event) => {
  switch (event.type) {
    case "fulfillment.return-shipment.requested.v1":
    case "fulfillment.return-shipment.requested.v2":
      return {
        ...initialReturnShipmentState,
        returnShipmentId: event.data.returnShipmentId,
        remedyId: event.data.remedyId,
        supportRequestId: event.data.supportRequestId,
        orderId: event.data.orderId,
        outboundShipmentId: event.data.outboundShipmentId,
        affectedOrderLineIds: "affectedOrderLineIds" in event.data ? event.data.affectedOrderLineIds : [],
        returnDirective: event.data.returnDirective,
        shipFromSnapshot: event.data.shipFromSnapshot,
        destinationSnapshot: event.data.destinationSnapshot,
        packageRequirements: event.data.packageRequirements,
        labelStatus: "pending",
        costPayer: event.data.costPayer,
        costAllocationReference: event.data.costAllocationReference,
        shipByDeadlineAt: event.data.shipByDeadlineAt,
        returnByDeadlineAt: event.data.returnByDeadlineAt,
        policyVersion: event.data.metadata.policyVersion,
        idempotencyKey: event.data.metadata.idempotencyKey,
        status: "requested",
        milestones: [{ status: "requested", occurredAt: event.data.requestedAt, detail: null }],
        requestedAt: event.data.requestedAt,
      };
    case "fulfillment.return-shipment.label-ready.v1":
      return {
        ...state,
        status: "ready-to-ship",
        labelStatus: "ready",
        carrierName: event.data.carrierName,
        trackingIdentifier: event.data.trackingIdentifier,
        labelProviderReference: event.data.labelProviderReference,
        labelDocumentUrl: event.data.labelDocumentUrl,
        postageProviderName: event.data.postageProviderName,
        postageProviderMode: event.data.postageProviderMode,
        postageProviderShipmentId: event.data.postageProviderShipmentId,
        postageProviderLabelId: event.data.postageProviderLabelId,
        postageAmountCents: event.data.postageAmountCents,
        estimatedPostageAmountCents: event.data.estimatedPostageAmountCents,
        postageCurrency: event.data.postageCurrency,
        labelFailureReason: null,
        labelFailureDetail: null,
        labelReadyAt: event.data.readyAt,
        milestones: withMilestone(state, "ready-to-ship", event.data.readyAt, null),
      };
    case "fulfillment.return-shipment.label-purchase-failed.v1":
      return {
        ...state,
        labelStatus: "failed",
        labelFailureReason: event.data.failureReason,
        labelFailureDetail: event.data.failureDetail,
        labelFailedAt: event.data.failedAt,
      };
    case "fulfillment.return-shipment.label-voided.v1":
      return {
        ...state,
        labelStatus: "voided",
        labelRefundStatus: event.data.refundStatus,
        labelRefundReference: event.data.refundReference,
        labelVoidedAt: event.data.voidedAt,
      };
    case "fulfillment.return-shipment.carrier-accepted.v1":
      return {
        ...state,
        status: "carrier-accepted",
        carrierAcceptedAt: event.data.occurredAt,
        milestones: withMilestone(state, "carrier-accepted", event.data.occurredAt, event.data.detail),
      };
    case "fulfillment.return-shipment.in-transit-recorded.v1":
      return {
        ...state,
        status: "in-transit",
        milestones: withMilestone(state, "in-transit", event.data.occurredAt, event.data.detail),
      };
    case "fulfillment.return-shipment.delivered.v1":
      return {
        ...state,
        status: "delivered",
        deliveredAt: event.data.deliveredAt,
        milestones: withMilestone(state, "delivered", event.data.deliveredAt, event.data.detail),
      };
    case "fulfillment.return-shipment.facility-intake-completed.v1":
      return {
        ...state,
        status: "received",
        receivedAt: event.data.intake.receivedAt,
        facilityIntake: event.data.intake,
        currentExceptionType: null,
        currentExceptionNotes: null,
        milestones: withMilestone(state, "received", event.data.intake.receivedAt, event.data.intake.disposition),
      };
    case "fulfillment.return-shipment.facility-intake-corrected.v1":
      return {
        ...state,
        intakeCorrections: [...state.intakeCorrections, event.data.correction],
        facilityIntake: state.facilityIntake
          ? {
              ...state.facilityIntake,
              custodyIdentifier: event.data.correction.custodyIdentifier ?? state.facilityIntake.custodyIdentifier,
              discrepancies: state.facilityIntake.discrepancies.map((entry) => ({
                ...entry,
                owner: event.data.correction.owner ?? entry.owner,
                nextAction: event.data.correction.nextAction ?? entry.nextAction,
              })),
            }
          : null,
      };
    case "fulfillment.return-shipment.duplicate-intake-scan-observed.v1":
      return { ...state, duplicateIntakeScanCount: state.duplicateIntakeScanCount + 1 };
    case "fulfillment.return-shipment.cancelled.v1":
      return {
        ...state,
        status: "cancelled",
        cancelledAt: event.data.cancelledAt,
        milestones: withMilestone(state, "cancelled", event.data.cancelledAt, event.data.reason),
      };
    case "fulfillment.return-shipment.expired.v1":
      return {
        ...state,
        status: "expired",
        expiredAt: event.data.expiredAt,
        milestones: withMilestone(state, "expired", event.data.expiredAt, event.data.reason),
      };
    case "fulfillment.return-shipment.exception-raised.v1":
      return {
        ...state,
        currentExceptionType: event.data.exceptionType,
        currentExceptionNotes: event.data.notes,
        exceptions: [
          ...state.exceptions,
          { exceptionType: event.data.exceptionType, notes: event.data.notes, raisedAt: event.data.raisedAt },
        ],
      };
    default:
      return assertNever(event);
  }
};
