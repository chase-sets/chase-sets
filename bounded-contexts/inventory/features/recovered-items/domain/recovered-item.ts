import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";
import { assert, assertNever, normalizeOptionalText } from "../../../support/runtime-support/common";

export const recoveredItemDispositions = [
  "return-to-original-seller",
  "return-to-buyer",
  "platform-resale",
  "liquidation",
  "donation",
  "destruction",
  "carrier-claim",
  "lost-unresolved",
] as const;
export type RecoveredItemDisposition = (typeof recoveredItemDispositions)[number];

export const recoveredValueTypes = [
  "resale-proceeds",
  "liquidation-proceeds",
  "carrier-claim",
  "postage-refund",
  "disposition-cost",
] as const;
export type RecoveredValueType = (typeof recoveredValueTypes)[number];

export type RecoveredItemStatus =
  | "awaiting-identification"
  | "quarantined"
  | "inspection-complete"
  | "authenticity-review"
  | "ready-for-disposition"
  | "sellable"
  | "transferred"
  | "disposed"
  | "merged";

export const recoveredItemLegalOwners = ["platform", "original-seller", "buyer", "unknown"] as const;
export const recoveredItemAuthorityKinds = [
  "terms-acceptance",
  "explicit-consent",
  "abandoned-property",
  "carrier-settlement",
  "legal-review",
] as const;
export const recoveredItemAuthenticityOutcomes = ["authentic", "not-authentic", "inconclusive"] as const;

export type RecoveredItemAuthority = Readonly<{
  legalOwner: "platform" | "original-seller" | "buyer" | "unknown";
  authorityKind: "terms-acceptance" | "explicit-consent" | "abandoned-property" | "carrier-settlement" | "legal-review";
  allowedDispositions: readonly RecoveredItemDisposition[];
  policyVersion: string;
  authorizedByUserId: string;
  evidenceReferences: readonly string[];
  authorizedAt: string;
}>;

export type RecoveredValueRecord = Readonly<{
  recoveryId: string;
  recoveryType: RecoveredValueType;
  grossAmount: string;
  costAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  recordedAt: string;
}>;

export type RecoveredItemState = Readonly<{
  recoveredItemId: string | null;
  returnShipmentId: string | null;
  remedyId: string | null;
  custodyLocationId: string | null;
  custodyIdentifier: string | null;
  evidenceReferences: readonly string[];
  status: RecoveredItemStatus | null;
  catalogItemId: string | null;
  productId: string | null;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  conditionGrade: string | null;
  authenticityReviewRequired: boolean;
  authenticityOutcome: "authentic" | "not-authentic" | "inconclusive" | null;
  authority: RecoveredItemAuthority | null;
  disposition: RecoveredItemDisposition | null;
  targetAccountId: string | null;
  storageLocationId: string | null;
  sellableAt: string | null;
  mergedIntoRecoveredItemId: string | null;
  recoveryRecords: Readonly<Record<string, RecoveredValueRecord>>;
}>;

export const initialRecoveredItemState: RecoveredItemState = {
  recoveredItemId: null,
  returnShipmentId: null,
  remedyId: null,
  custodyLocationId: null,
  custodyIdentifier: null,
  evidenceReferences: [],
  status: null,
  catalogItemId: null,
  productId: null,
  selectedOptions: [],
  conditionGrade: null,
  authenticityReviewRequired: false,
  authenticityOutcome: null,
  authority: null,
  disposition: null,
  targetAccountId: null,
  storageLocationId: null,
  sellableAt: null,
  mergedIntoRecoveredItemId: null,
  recoveryRecords: {},
};

export type CreateRecoveredItemCommand = Readonly<{
  type: "CreateRecoveredItem";
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  custodyLocationId: string;
  custodyIdentifier: string;
  evidenceReferences: readonly string[];
  intakeDisposition: "completed" | "quarantine" | "manual-review";
  hasDiscrepancy: boolean;
  observedItemReference: string | null;
  policyVersion: string;
  receivedAt: string;
}>;

export type IdentifyRecoveredItemCommand = Readonly<{
  type: "IdentifyRecoveredItem";
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  identifiedByUserId: string;
  evidenceReferences: readonly string[];
  identifiedAt: string;
}>;

export type CompleteRecoveredItemInspectionCommand = Readonly<{
  type: "CompleteRecoveredItemInspection";
  conditionGrade: string;
  inspectedByUserId: string;
  evidenceReferences: readonly string[];
  inspectedAt: string;
}>;

export type RequireRecoveredItemAuthenticityReviewCommand = Readonly<{
  type: "RequireRecoveredItemAuthenticityReview";
  policyVersion: string;
  reasonCode: string;
  requestedByUserId: string;
  evidenceReferences: readonly string[];
  requestedAt: string;
}>;

export type CompleteRecoveredItemAuthenticityReviewCommand = Readonly<{
  type: "CompleteRecoveredItemAuthenticityReview";
  outcome: "authentic" | "not-authentic" | "inconclusive";
  reviewReference: string;
  reviewedByUserId: string;
  evidenceReferences: readonly string[];
  reviewedAt: string;
}>;

export type RecordRecoveredItemDispositionAuthorityCommand = RecoveredItemAuthority &
  Readonly<{ type: "RecordRecoveredItemDispositionAuthority" }>;

export type DecideRecoveredItemDispositionCommand = Readonly<{
  type: "DecideRecoveredItemDisposition";
  disposition: RecoveredItemDisposition;
  targetAccountId: string | null;
  storageLocationId: string | null;
  policyVersion: string;
  decidedByUserId: string;
  evidenceReferences: readonly string[];
  reasonCode: string;
  decidedAt: string;
}>;

export type RecordRecoveredItemValueCommand = RecoveredValueRecord &
  Readonly<{ type: "RecordRecoveredItemValue"; recordedByUserId: string }>;

export type CorrectRecoveredItemSourceCommand = Readonly<{
  type: "CorrectRecoveredItemSource";
  correctedReturnShipmentId: string;
  reason: string;
  correctedByUserId: string;
  evidenceReferences: readonly string[];
  correctedAt: string;
}>;

export type MergeRecoveredItemCommand = Readonly<{
  type: "MergeRecoveredItem";
  canonicalRecoveredItemId: string;
  reason: string;
  mergedByUserId: string;
  evidenceReferences: readonly string[];
  mergedAt: string;
}>;

export type RecoveredItemCommand =
  | CreateRecoveredItemCommand
  | IdentifyRecoveredItemCommand
  | CompleteRecoveredItemInspectionCommand
  | RequireRecoveredItemAuthenticityReviewCommand
  | CompleteRecoveredItemAuthenticityReviewCommand
  | RecordRecoveredItemDispositionAuthorityCommand
  | DecideRecoveredItemDispositionCommand
  | RecordRecoveredItemValueCommand
  | CorrectRecoveredItemSourceCommand
  | MergeRecoveredItemCommand;

type CreatedEvent = DomainEvent<"inventory.recovered-item.created.v1", Omit<CreateRecoveredItemCommand, "type">>;
type IdentifiedEvent = DomainEvent<
  "inventory.recovered-item.identified.v1",
  Omit<IdentifyRecoveredItemCommand, "type">
>;
type InspectionCompletedEvent = DomainEvent<
  "inventory.recovered-item.inspection-completed.v1",
  Omit<CompleteRecoveredItemInspectionCommand, "type">
>;
type AuthenticityRequiredEvent = DomainEvent<
  "inventory.recovered-item.authenticity-review-required.v1",
  RecoveredItemAuthenticityReviewRequestedFact
>;
type AuthenticityCompletedEvent = DomainEvent<
  "inventory.recovered-item.authenticity-review-completed.v1",
  Omit<CompleteRecoveredItemAuthenticityReviewCommand, "type">
>;
type AuthorityRecordedEvent = DomainEvent<
  "inventory.recovered-item.disposition-authority-recorded.v1",
  RecoveredItemAuthority
>;
type DispositionDecidedEvent = DomainEvent<
  "inventory.recovered-item.disposition-decided.v1",
  Omit<DecideRecoveredItemDispositionCommand, "type">
>;
type SellableEvent = DomainEvent<"inventory.recovered-item.sellable.v1", RecoveredItemDispositionFact>;
type TransferredEvent = DomainEvent<"inventory.recovered-item.transferred.v1", RecoveredItemDispositionFact>;
type DisposedEvent = DomainEvent<"inventory.recovered-item.disposed.v1", RecoveredItemDispositionFact>;
type ValueReportedEvent = DomainEvent<"inventory.recovered-item.value-reported.v1", RecoveredItemValueFact>;
type SourceCorrectedEvent = DomainEvent<
  "inventory.recovered-item.source-corrected.v1",
  Omit<CorrectRecoveredItemSourceCommand, "type"> & Readonly<{ previousReturnShipmentId: string }>
>;
type MergedEvent = DomainEvent<"inventory.recovered-item.merged.v1", Omit<MergeRecoveredItemCommand, "type">>;

export type RecoveredItemDispositionFact = Readonly<{
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  disposition: RecoveredItemDisposition;
  policyVersion: string;
  authorityKind: RecoveredItemAuthority["authorityKind"] | null;
  evidenceReferences: readonly string[];
  targetAccountId: string | null;
  storageLocationId: string | null;
  occurredAt: string;
}>;

export type RecoveredItemAuthenticityReviewRequestedFact = Readonly<{
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  policyVersion: string;
  reasonCode: string;
  requestedByUserId: string;
  evidenceReferences: readonly string[];
  requestedAt: string;
}>;

export type RecoveredItemValueFact = Readonly<{
  factSchemaVersion: 1;
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  recoveryId: string;
  recoveryType: RecoveredValueType;
  grossAmount: string;
  costAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  recordedAt: string;
}>;

export type RecoveredItemEvent =
  | CreatedEvent
  | IdentifiedEvent
  | InspectionCompletedEvent
  | AuthenticityRequiredEvent
  | AuthenticityCompletedEvent
  | AuthorityRecordedEvent
  | DispositionDecidedEvent
  | SellableEvent
  | TransferredEvent
  | DisposedEvent
  | ValueReportedEvent
  | SourceCorrectedEvent
  | MergedEvent;

function required(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function timestamp(value: string, message: string): string {
  const normalized = required(value, message);
  assert(!Number.isNaN(Date.parse(normalized)), message);
  return normalized;
}

function evidence(values: readonly string[]): readonly string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  assert(normalized.length > 0, "Recovered item actions require evidence.");
  return normalized;
}

function assertActive(state: RecoveredItemState): void {
  assert(state.recoveredItemId !== null, "Recovered item must exist first.");
  assert(state.status !== "merged", "A merged recovered item cannot be changed.");
}

function dispositionFact(
  state: RecoveredItemState,
  command: DecideRecoveredItemDispositionCommand,
): RecoveredItemDispositionFact {
  return {
    recoveredItemId: state.recoveredItemId!,
    returnShipmentId: state.returnShipmentId!,
    remedyId: state.remedyId!,
    disposition: command.disposition,
    policyVersion: command.policyVersion,
    authorityKind: state.authority?.authorityKind ?? null,
    evidenceReferences: evidence(command.evidenceReferences),
    targetAccountId: normalizeOptionalText(command.targetAccountId),
    storageLocationId: normalizeOptionalText(command.storageLocationId),
    occurredAt: timestamp(command.decidedAt, "Disposition decision must record a timestamp."),
  };
}

export const decideRecoveredItem: AggregateDecider<RecoveredItemState, RecoveredItemCommand, RecoveredItemEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreateRecoveredItem": {
      if (state.recoveredItemId !== null) {
        assert(
          state.returnShipmentId === command.returnShipmentId && state.remedyId === command.remedyId,
          "Recovered item id was reused for a different intake.",
        );
        return [];
      }
      return [
        {
          type: "inventory.recovered-item.created.v1",
          data: {
            recoveredItemId: required(command.recoveredItemId, "Recovered item id is required."),
            returnShipmentId: required(command.returnShipmentId, "Return shipment id is required."),
            remedyId: required(command.remedyId, "Remedy id is required."),
            custodyLocationId: required(command.custodyLocationId, "Custody location is required."),
            custodyIdentifier: required(command.custodyIdentifier, "Custody identifier is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            intakeDisposition: command.intakeDisposition,
            hasDiscrepancy: command.hasDiscrepancy,
            observedItemReference: normalizeOptionalText(command.observedItemReference),
            policyVersion: required(command.policyVersion, "Intake policy version is required."),
            receivedAt: timestamp(command.receivedAt, "Facility receipt must record a timestamp."),
          },
        },
      ];
    }
    case "IdentifyRecoveredItem":
      assertActive(state);
      assert(state.disposition === null, "A disposed recovered item cannot be reidentified.");
      return [
        {
          type: "inventory.recovered-item.identified.v1",
          data: {
            catalogItemId: required(command.catalogItemId, "Catalog item id is required."),
            productId: required(command.productId, "Product id is required."),
            selectedOptions: command.selectedOptions.map((option) => ({
              dimensionId: required(option.dimensionId, "Selected option dimension is required."),
              optionId: required(option.optionId, "Selected option is required."),
            })),
            identifiedByUserId: required(command.identifiedByUserId, "Identifying operator is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            identifiedAt: timestamp(command.identifiedAt, "Identification must record a timestamp."),
          },
        },
      ];
    case "CompleteRecoveredItemInspection":
      assertActive(state);
      assert(state.catalogItemId !== null, "Recovered item must be identified before inspection completes.");
      return [
        {
          type: "inventory.recovered-item.inspection-completed.v1",
          data: {
            conditionGrade: required(command.conditionGrade, "Condition grade is required."),
            inspectedByUserId: required(command.inspectedByUserId, "Inspecting operator is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            inspectedAt: timestamp(command.inspectedAt, "Inspection must record a timestamp."),
          },
        },
      ];
    case "RequireRecoveredItemAuthenticityReview":
      assertActive(state);
      assert(state.conditionGrade !== null, "Inspection must complete before authenticity policy is applied.");
      return [
        {
          type: "inventory.recovered-item.authenticity-review-required.v1",
          data: {
            recoveredItemId: state.recoveredItemId!,
            returnShipmentId: state.returnShipmentId!,
            remedyId: state.remedyId!,
            catalogItemId: state.catalogItemId!,
            productId: state.productId!,
            selectedOptions: state.selectedOptions,
            policyVersion: required(command.policyVersion, "Authenticity policy version is required."),
            reasonCode: required(command.reasonCode, "Authenticity review reason is required."),
            requestedByUserId: required(command.requestedByUserId, "Requesting operator is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            requestedAt: timestamp(command.requestedAt, "Authenticity request must record a timestamp."),
          },
        },
      ];
    case "CompleteRecoveredItemAuthenticityReview":
      assertActive(state);
      assert(state.authenticityReviewRequired, "Authenticity review was not required by policy.");
      assert(
        recoveredItemAuthenticityOutcomes.includes(command.outcome),
        "Authenticity review outcome is unsupported.",
      );
      return [
        {
          type: "inventory.recovered-item.authenticity-review-completed.v1",
          data: {
            outcome: command.outcome,
            reviewReference: required(command.reviewReference, "Authenticity review reference is required."),
            reviewedByUserId: required(command.reviewedByUserId, "Reviewing operator is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            reviewedAt: timestamp(command.reviewedAt, "Authenticity review must record a timestamp."),
          },
        },
      ];
    case "RecordRecoveredItemDispositionAuthority": {
      assertActive(state);
      assert(
        recoveredItemLegalOwners.includes(command.legalOwner),
        "Disposition authority legal owner is unsupported.",
      );
      assert(recoveredItemAuthorityKinds.includes(command.authorityKind), "Disposition authority kind is unsupported.");
      const allowedDispositions = [...new Set(command.allowedDispositions)];
      assert(allowedDispositions.length > 0, "Disposition authority must allow at least one action.");
      assert(
        allowedDispositions.every((value) => recoveredItemDispositions.includes(value)),
        "Disposition authority contains an unsupported action.",
      );
      return [
        {
          type: "inventory.recovered-item.disposition-authority-recorded.v1",
          data: {
            legalOwner: command.legalOwner,
            authorityKind: command.authorityKind,
            allowedDispositions,
            policyVersion: required(command.policyVersion, "Disposition authority policy version is required."),
            authorizedByUserId: required(command.authorizedByUserId, "Authorizing operator is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            authorizedAt: timestamp(command.authorizedAt, "Disposition authority must record a timestamp."),
          },
        },
      ];
    }
    case "DecideRecoveredItemDisposition": {
      assertActive(state);
      assert(state.disposition === null, "Recovered item disposition is already terminal or approved.");
      assert(recoveredItemDispositions.includes(command.disposition), "Unsupported recovered item disposition.");
      const fact = dispositionFact(state, command);
      if (command.disposition !== "lost-unresolved") {
        assert(
          state.authority !== null &&
            state.authority.legalOwner !== "unknown" &&
            state.authority.allowedDispositions.includes(command.disposition) &&
            state.authority.policyVersion === command.policyVersion,
          "Disposition requires explicit ownership and policy authority.",
        );
      }
      if (command.disposition === "platform-resale") {
        assert(state.authority?.legalOwner === "platform", "Only platform-owned recovered items can be resold.");
        assert(
          state.catalogItemId !== null && state.productId !== null,
          "Resale requires identified product identity.",
        );
        assert(state.conditionGrade !== null, "Resale requires completed condition inspection.");
        assert(fact.storageLocationId !== null, "Resale requires an Inventory custody location.");
        assert(
          !state.authenticityReviewRequired || state.authenticityOutcome === "authentic",
          "Authenticity review must be complete and authentic before resale.",
        );
      }
      if (command.disposition === "return-to-original-seller" || command.disposition === "return-to-buyer") {
        assert(fact.targetAccountId !== null, "A return disposition requires its target account.");
      }
      const decided: DispositionDecidedEvent = {
        type: "inventory.recovered-item.disposition-decided.v1",
        data: {
          ...command,
          targetAccountId: fact.targetAccountId,
          storageLocationId: fact.storageLocationId,
          evidenceReferences: fact.evidenceReferences,
          policyVersion: fact.policyVersion,
          decidedByUserId: required(command.decidedByUserId, "Deciding operator is required."),
          reasonCode: required(command.reasonCode, "Disposition reason is required."),
          decidedAt: fact.occurredAt,
        },
      };
      if (command.disposition === "platform-resale") {
        return [decided, { type: "inventory.recovered-item.sellable.v1", data: fact }];
      }
      if (command.disposition === "return-to-original-seller" || command.disposition === "return-to-buyer") {
        return [decided, { type: "inventory.recovered-item.transferred.v1", data: fact }];
      }
      return [decided, { type: "inventory.recovered-item.disposed.v1", data: fact }];
    }
    case "RecordRecoveredItemValue": {
      assertActive(state);
      assert(state.disposition !== null, "Recovered value requires a recorded disposition.");
      const existing = state.recoveryRecords[command.recoveryId];
      const grossAmount = normalizeMoneyAmount(command.grossAmount);
      const costAmount = normalizeMoneyAmount(command.costAmount);
      const currencyCode = required(command.currencyCode, "Recovery currency is required.").toUpperCase();
      if (existing) {
        assert(
          existing.recoveryType === command.recoveryType &&
            existing.grossAmount === grossAmount &&
            existing.costAmount === costAmount &&
            existing.currencyCode === currencyCode,
          "Recovery id was reused with different value terms.",
        );
        return [];
      }
      assert(recoveredValueTypes.includes(command.recoveryType), "Unsupported recovered value type.");
      assert(grossAmount !== "0.00" || costAmount !== "0.00", "A recovery posting cannot be zero.");
      required(command.recordedByUserId, "Recording operator is required.");
      return [
        {
          type: "inventory.recovered-item.value-reported.v1",
          data: {
            factSchemaVersion: 1,
            recoveredItemId: state.recoveredItemId!,
            returnShipmentId: state.returnShipmentId!,
            remedyId: state.remedyId!,
            recoveryId: required(command.recoveryId, "Recovery id is required."),
            recoveryType: command.recoveryType,
            grossAmount,
            costAmount,
            currencyCode,
            policyVersion: required(command.policyVersion, "Recovery policy version is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            recordedAt: timestamp(command.recordedAt, "Recovery posting must record a timestamp."),
          },
        },
      ];
    }
    case "CorrectRecoveredItemSource":
      assertActive(state);
      assert(state.disposition === null, "A terminal disposition cannot change its intake source.");
      return [
        {
          type: "inventory.recovered-item.source-corrected.v1",
          data: {
            previousReturnShipmentId: state.returnShipmentId!,
            correctedReturnShipmentId: required(
              command.correctedReturnShipmentId,
              "Corrected return shipment is required.",
            ),
            reason: required(command.reason, "Source correction reason is required."),
            correctedByUserId: required(command.correctedByUserId, "Correcting operator is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            correctedAt: timestamp(command.correctedAt, "Source correction must record a timestamp."),
          },
        },
      ];
    case "MergeRecoveredItem":
      assertActive(state);
      assert(state.disposition === null, "A terminal disposition cannot be merged.");
      assert(command.canonicalRecoveredItemId !== state.recoveredItemId, "Recovered item cannot merge into itself.");
      return [
        {
          type: "inventory.recovered-item.merged.v1",
          data: {
            canonicalRecoveredItemId: required(
              command.canonicalRecoveredItemId,
              "Canonical recovered item is required.",
            ),
            reason: required(command.reason, "Merge reason is required."),
            mergedByUserId: required(command.mergedByUserId, "Merging operator is required."),
            evidenceReferences: evidence(command.evidenceReferences),
            mergedAt: timestamp(command.mergedAt, "Merge must record a timestamp."),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveRecoveredItem: AggregateEvolver<RecoveredItemState, RecoveredItemEvent> = (state, event) => {
  switch (event.type) {
    case "inventory.recovered-item.created.v1":
      return {
        ...initialRecoveredItemState,
        recoveredItemId: event.data.recoveredItemId,
        returnShipmentId: event.data.returnShipmentId,
        remedyId: event.data.remedyId,
        custodyLocationId: event.data.custodyLocationId,
        custodyIdentifier: event.data.custodyIdentifier,
        evidenceReferences: event.data.evidenceReferences,
        status:
          event.data.observedItemReference === null || event.data.hasDiscrepancy
            ? "awaiting-identification"
            : "quarantined",
      };
    case "inventory.recovered-item.identified.v1":
      return {
        ...state,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        selectedOptions: event.data.selectedOptions,
        status: "quarantined",
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    case "inventory.recovered-item.inspection-completed.v1":
      return {
        ...state,
        conditionGrade: event.data.conditionGrade,
        status: "inspection-complete",
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    case "inventory.recovered-item.authenticity-review-required.v1":
      return {
        ...state,
        authenticityReviewRequired: true,
        authenticityOutcome: null,
        status: "authenticity-review",
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    case "inventory.recovered-item.authenticity-review-completed.v1":
      return {
        ...state,
        authenticityOutcome: event.data.outcome,
        status: "inspection-complete",
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    case "inventory.recovered-item.disposition-authority-recorded.v1":
      return {
        ...state,
        authority: event.data,
        status:
          state.conditionGrade !== null && (!state.authenticityReviewRequired || state.authenticityOutcome !== null)
            ? "ready-for-disposition"
            : state.status,
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    case "inventory.recovered-item.disposition-decided.v1":
      return {
        ...state,
        disposition: event.data.disposition,
        targetAccountId: event.data.targetAccountId,
        storageLocationId: event.data.storageLocationId,
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    case "inventory.recovered-item.sellable.v1":
      return { ...state, status: "sellable", sellableAt: event.data.occurredAt };
    case "inventory.recovered-item.transferred.v1":
      return { ...state, status: "transferred" };
    case "inventory.recovered-item.disposed.v1":
      return { ...state, status: "disposed" };
    case "inventory.recovered-item.value-reported.v1": {
      const record: RecoveredValueRecord = {
        recoveryId: event.data.recoveryId,
        recoveryType: event.data.recoveryType,
        grossAmount: event.data.grossAmount,
        costAmount: event.data.costAmount,
        currencyCode: event.data.currencyCode,
        policyVersion: event.data.policyVersion,
        evidenceReferences: event.data.evidenceReferences,
        recordedAt: event.data.recordedAt,
      };
      return { ...state, recoveryRecords: { ...state.recoveryRecords, [record.recoveryId]: record } };
    }
    case "inventory.recovered-item.source-corrected.v1":
      return {
        ...state,
        returnShipmentId: event.data.correctedReturnShipmentId,
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    case "inventory.recovered-item.merged.v1":
      return {
        ...state,
        status: "merged",
        mergedIntoRecoveredItemId: event.data.canonicalRecoveredItemId,
        evidenceReferences: [...state.evidenceReferences, ...event.data.evidenceReferences],
      };
    default:
      return assertNever(event);
  }
};
