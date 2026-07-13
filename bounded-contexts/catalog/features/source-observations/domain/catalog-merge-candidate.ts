import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { assert, assertNever, ensureUniqueBy } from "../../../support/runtime-support/common";

export type CatalogMergeCandidateStatus = "ready" | "has-conflicts" | "stale" | "deferred" | "rejected" | "promoted";

export type CatalogMergeCandidatePromotionIntent =
  | "create-catalog-item"
  | "update-catalog-item"
  | "link-existing-catalog-item";

export type CatalogMergeCandidateIdentity = JsonObject &
  Readonly<{
    scopeRecordId: string;
    collectorNumber: string | null;
    languageCode: string;
    productForm: string | null;
    variantKey: string | null;
    barcode: string | null;
  }>;

export type CatalogMergeCandidateObservationMember = JsonObject &
  Readonly<{
    observationId: string;
    syncRunId: string | null;
    providerKey: string;
    externalKey: string;
    sourceRecordHash: string;
    sourceProfileKey: string;
    sourceProfileVersion: string;
    sourceMappingFingerprint: string;
    observedAt: string;
    addedAt: string;
  }>;

export type CatalogMergeCandidateMatches = JsonObject &
  Readonly<{
    catalogItemId: string | null;
    productIds: readonly string[];
  }>;

export type CatalogMergeCandidateExternalCatalogItemReference = JsonObject &
  Readonly<{
    providerKey: string;
    externalKey: string;
  }>;

export type CatalogMergeCandidateSelectedOptionReference = JsonObject &
  Readonly<{
    dimensionId: string;
    optionId: string;
  }>;

export type CatalogMergeCandidateExternalProductReference = JsonObject &
  Readonly<{
    providerKey: string;
    externalKey: string;
    selectedOptions: readonly CatalogMergeCandidateSelectedOptionReference[];
    reviewEvidence: JsonObject | null;
  }>;

export type CatalogMergeCandidateConflict = JsonObject &
  Readonly<{
    code: string;
    severity: "blocking" | "warning";
    message: string;
    fieldPath: string | null;
    observationIds: readonly string[];
    existingValue: JsonValue;
    proposedValue: JsonValue;
  }>;

export type CatalogMergeCandidateWarning = JsonObject &
  Readonly<{
    code: string;
    message: string;
    fieldPath: string | null;
    observationIds: readonly string[];
  }>;

export type CatalogMergeCandidateFieldProvenance = JsonObject &
  Readonly<{
    fieldPath: string;
    value: JsonValue;
    observationId: string;
    providerKey: string;
    sourceProfileKey: string;
    sourceProfileVersion: string;
    confidence: "exact" | "high" | "candidate" | "manual";
    evidence: JsonObject;
  }>;

export type CatalogMergeCandidateReviewActor = JsonObject &
  Readonly<{
    userId: string | null;
    accountId: string | null;
  }>;

export type CatalogMergeCandidateConflictResolution = JsonObject &
  Readonly<{
    conflictCode: string;
    fieldPath: string | null;
    chosenValue: JsonValue;
    reason: string;
    observationIds: readonly string[];
  }>;

export type CatalogMergeCandidateMembershipChanges = JsonObject &
  Readonly<{
    addedObservationIds: readonly string[];
    removedObservationIds: readonly string[];
  }>;

export type CatalogMergeCandidateActionAudit = JsonObject &
  Readonly<{
    action: "promote" | "split" | "update" | "ignore" | "defer";
    actor: CatalogMergeCandidateReviewActor;
    reason: string;
    decidedAt: string;
    beforeIdentity: CatalogMergeCandidateIdentity;
    afterIdentity: CatalogMergeCandidateIdentity;
    membershipChanges: CatalogMergeCandidateMembershipChanges;
    conflictResolutions: readonly CatalogMergeCandidateConflictResolution[];
  }>;

export type CatalogMergeCandidateReviewSnapshot = JsonObject &
  Readonly<{
    identityFingerprint: string;
    syncRunIds: readonly string[];
    identity: CatalogMergeCandidateIdentity;
    membership: readonly CatalogMergeCandidateObservationMember[];
    matches: CatalogMergeCandidateMatches;
    proposedCatalogItemFacts: JsonObject;
    proposedExternalCatalogItemReferences: readonly CatalogMergeCandidateExternalCatalogItemReference[];
    proposedExternalProductReferences: readonly CatalogMergeCandidateExternalProductReference[];
    conflicts: readonly CatalogMergeCandidateConflict[];
    warnings: readonly CatalogMergeCandidateWarning[];
    fieldProvenance: readonly CatalogMergeCandidateFieldProvenance[];
    promotionIntent: CatalogMergeCandidatePromotionIntent;
  }>;

export type CatalogMergeCandidateState = Readonly<{
  id: string | null;
  status: CatalogMergeCandidateStatus;
  statusReason: string | null;
  snapshot: CatalogMergeCandidateReviewSnapshot | null;
  createdAt: string | null;
  updatedAt: string | null;
  staleAt: string | null;
}>;

export const initialCatalogMergeCandidateState: CatalogMergeCandidateState = {
  id: null,
  status: "ready",
  statusReason: null,
  snapshot: null,
  createdAt: null,
  updatedAt: null,
  staleAt: null,
};

export type CreateCatalogMergeCandidateCommand = Readonly<{
  type: "CreateCatalogMergeCandidate";
  candidateId: string;
  snapshot: CatalogMergeCandidateReviewSnapshot;
  createdAt: string;
}>;

export type RefreshCatalogMergeCandidateCommand = Readonly<{
  type: "RefreshCatalogMergeCandidate";
  snapshot: CatalogMergeCandidateReviewSnapshot;
  refreshedAt: string;
}>;

export type MarkCatalogMergeCandidateStaleCommand = Readonly<{
  type: "MarkCatalogMergeCandidateStale";
  reason: string;
  staleAt: string;
  triggeredByObservationIds: readonly string[];
}>;

export type AddObservationToCatalogMergeCandidateCommand = Readonly<{
  type: "AddObservationToCatalogMergeCandidate";
  member: CatalogMergeCandidateObservationMember;
  updatedAt: string;
}>;

export type RemoveObservationFromCatalogMergeCandidateCommand = Readonly<{
  type: "RemoveObservationFromCatalogMergeCandidate";
  observationId: string;
  reason: string;
  removedAt: string;
}>;

export type PromoteCatalogMergeCandidateCommand = Readonly<{
  type: "PromoteCatalogMergeCandidate";
  reason: string;
  actor: CatalogMergeCandidateReviewActor;
  promotedAt: string;
  conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
}>;

export type SplitCatalogMergeCandidateCommand = Readonly<{
  type: "SplitCatalogMergeCandidate";
  remainingSnapshot: CatalogMergeCandidateReviewSnapshot;
  splitCandidateId: string;
  splitSnapshot: CatalogMergeCandidateReviewSnapshot;
  reason: string;
  actor: CatalogMergeCandidateReviewActor;
  splitAt: string;
  conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
}>;

export type UpdateCatalogMergeCandidateCommand = Readonly<{
  type: "UpdateCatalogMergeCandidate";
  snapshot: CatalogMergeCandidateReviewSnapshot;
  reason: string;
  actor: CatalogMergeCandidateReviewActor;
  updatedAt: string;
  conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
}>;

export type IgnoreCatalogMergeCandidateCommand = Readonly<{
  type: "IgnoreCatalogMergeCandidate";
  reason: string;
  actor: CatalogMergeCandidateReviewActor;
  ignoredAt: string;
  conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
}>;

export type DeferCatalogMergeCandidateCommand = Readonly<{
  type: "DeferCatalogMergeCandidate";
  reason: string;
  actor: CatalogMergeCandidateReviewActor;
  deferredAt: string;
  conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[];
}>;

export type CatalogMergeCandidateCommand =
  | CreateCatalogMergeCandidateCommand
  | RefreshCatalogMergeCandidateCommand
  | MarkCatalogMergeCandidateStaleCommand
  | AddObservationToCatalogMergeCandidateCommand
  | RemoveObservationFromCatalogMergeCandidateCommand
  | PromoteCatalogMergeCandidateCommand
  | SplitCatalogMergeCandidateCommand
  | UpdateCatalogMergeCandidateCommand
  | IgnoreCatalogMergeCandidateCommand
  | DeferCatalogMergeCandidateCommand;

type CatalogMergeCandidateCreatedEventData = JsonObject &
  Readonly<{
    candidateId: string;
    status: Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts">;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    createdAt: string;
  }>;

type CatalogMergeCandidateRefreshedEventData = JsonObject &
  Readonly<{
    candidateId: string;
    status: Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts">;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    refreshedAt: string;
  }>;

type CatalogMergeCandidateMarkedStaleEventData = JsonObject &
  Readonly<{
    candidateId: string;
    reason: string;
    staleAt: string;
    triggeredByObservationIds: readonly string[];
  }>;

type CatalogMergeCandidateObservationAddedEventData = JsonObject &
  Readonly<{
    candidateId: string;
    member: CatalogMergeCandidateObservationMember;
    updatedAt: string;
  }>;

type CatalogMergeCandidateObservationRemovedEventData = JsonObject &
  Readonly<{
    candidateId: string;
    observationId: string;
    reason: string;
    removedAt: string;
  }>;

type CatalogMergeCandidatePromotedEventData = JsonObject &
  Readonly<{
    candidateId: string;
    audit: CatalogMergeCandidateActionAudit;
    promotedAt: string;
  }>;

type CatalogMergeCandidateSplitEventData = JsonObject &
  Readonly<{
    candidateId: string;
    status: Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts">;
    remainingSnapshot: CatalogMergeCandidateReviewSnapshot;
    splitCandidateId: string;
    splitSnapshot: CatalogMergeCandidateReviewSnapshot;
    audit: CatalogMergeCandidateActionAudit;
    splitAt: string;
  }>;

type CatalogMergeCandidateUpdatedEventData = JsonObject &
  Readonly<{
    candidateId: string;
    status: Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts">;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    audit: CatalogMergeCandidateActionAudit;
    updatedAt: string;
  }>;

type CatalogMergeCandidateIgnoredEventData = JsonObject &
  Readonly<{
    candidateId: string;
    audit: CatalogMergeCandidateActionAudit;
    ignoredAt: string;
  }>;

type CatalogMergeCandidateDeferredEventData = JsonObject &
  Readonly<{
    candidateId: string;
    audit: CatalogMergeCandidateActionAudit;
    deferredAt: string;
  }>;

export type CatalogMergeCandidateCreatedEvent = DomainEvent<
  "catalog.merge-candidate.created",
  CatalogMergeCandidateCreatedEventData
>;

export type CatalogMergeCandidateRefreshedEvent = DomainEvent<
  "catalog.merge-candidate.refreshed",
  CatalogMergeCandidateRefreshedEventData
>;

export type CatalogMergeCandidateMarkedStaleEvent = DomainEvent<
  "catalog.merge-candidate.marked-stale",
  CatalogMergeCandidateMarkedStaleEventData
>;

export type CatalogMergeCandidateObservationAddedEvent = DomainEvent<
  "catalog.merge-candidate.observation-added",
  CatalogMergeCandidateObservationAddedEventData
>;

export type CatalogMergeCandidateObservationRemovedEvent = DomainEvent<
  "catalog.merge-candidate.observation-removed",
  CatalogMergeCandidateObservationRemovedEventData
>;

export type CatalogMergeCandidatePromotedEvent = DomainEvent<
  "catalog.merge-candidate.promoted",
  CatalogMergeCandidatePromotedEventData
>;

export type CatalogMergeCandidateSplitEvent = DomainEvent<
  "catalog.merge-candidate.split",
  CatalogMergeCandidateSplitEventData
>;

export type CatalogMergeCandidateUpdatedEvent = DomainEvent<
  "catalog.merge-candidate.updated",
  CatalogMergeCandidateUpdatedEventData
>;

export type CatalogMergeCandidateIgnoredEvent = DomainEvent<
  "catalog.merge-candidate.ignored",
  CatalogMergeCandidateIgnoredEventData
>;

export type CatalogMergeCandidateDeferredEvent = DomainEvent<
  "catalog.merge-candidate.deferred",
  CatalogMergeCandidateDeferredEventData
>;

export type CatalogMergeCandidateEvent =
  | CatalogMergeCandidateCreatedEvent
  | CatalogMergeCandidateRefreshedEvent
  | CatalogMergeCandidateMarkedStaleEvent
  | CatalogMergeCandidateObservationAddedEvent
  | CatalogMergeCandidateObservationRemovedEvent
  | CatalogMergeCandidatePromotedEvent
  | CatalogMergeCandidateSplitEvent
  | CatalogMergeCandidateUpdatedEvent
  | CatalogMergeCandidateIgnoredEvent
  | CatalogMergeCandidateDeferredEvent;

export const decideCatalogMergeCandidate: AggregateDecider<
  CatalogMergeCandidateState,
  CatalogMergeCandidateCommand,
  CatalogMergeCandidateEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateCatalogMergeCandidate": {
      assert(state.id === null, "Catalog Merge Candidate already exists.");
      const candidateId = requireText(command.candidateId, "Catalog Merge Candidate ID");
      const snapshot = normalizeReviewSnapshot(command.snapshot);

      return [
        {
          type: "catalog.merge-candidate.created",
          data: {
            candidateId,
            status: statusForSnapshot(snapshot),
            snapshot,
            createdAt: command.createdAt,
          },
        },
      ];
    }
    case "RefreshCatalogMergeCandidate": {
      requireRefreshable(state);
      const snapshot = normalizeReviewSnapshot(command.snapshot);

      return [
        {
          type: "catalog.merge-candidate.refreshed",
          data: {
            candidateId: state.id,
            status: statusForSnapshot(snapshot),
            snapshot,
            refreshedAt: command.refreshedAt,
          },
        },
      ];
    }
    case "MarkCatalogMergeCandidateStale": {
      requireRefreshable(state);
      const reason = requireText(command.reason, "Stale reason");
      const triggeredByObservationIds = normalizeObservationIds(command.triggeredByObservationIds);

      return [
        {
          type: "catalog.merge-candidate.marked-stale",
          data: {
            candidateId: state.id,
            reason,
            staleAt: command.staleAt,
            triggeredByObservationIds,
          },
        },
      ];
    }
    case "AddObservationToCatalogMergeCandidate": {
      requireRefreshable(state);
      const member = normalizeObservationMember(command.member);
      assert(
        !state.snapshot.membership.some((existing) => existing.observationId === member.observationId),
        "Source Observation already belongs to this Catalog Merge Candidate.",
      );

      return [
        {
          type: "catalog.merge-candidate.observation-added",
          data: {
            candidateId: state.id,
            member,
            updatedAt: command.updatedAt,
          },
        },
      ];
    }
    case "RemoveObservationFromCatalogMergeCandidate": {
      requireRefreshable(state);
      const observationId = requireText(command.observationId, "Source Observation ID");
      assert(
        state.snapshot.membership.some((member) => member.observationId === observationId),
        "Source Observation does not belong to this Catalog Merge Candidate.",
      );
      assert(state.snapshot.membership.length > 1, "Catalog Merge Candidates require at least one Source Observation.");

      return [
        {
          type: "catalog.merge-candidate.observation-removed",
          data: {
            candidateId: state.id,
            observationId,
            reason: requireText(command.reason, "Removal reason"),
            removedAt: command.removedAt,
          },
        },
      ];
    }
    case "PromoteCatalogMergeCandidate": {
      requireReviewActionable(state);
      assert(state.status !== "stale", "Stale Catalog Merge Candidates must be refreshed before promotion.");
      requireConflictResolutionsForBlockingConflicts(state, command.conflictResolutions ?? []);
      const reason = requireText(command.reason, "Promotion reason");

      return [
        {
          type: "catalog.merge-candidate.promoted",
          data: {
            candidateId: state.id,
            promotedAt: command.promotedAt,
            audit: actionAudit({
              action: "promote",
              actor: command.actor,
              reason,
              decidedAt: command.promotedAt,
              beforeSnapshot: state.snapshot,
              afterSnapshot: state.snapshot,
              conflictResolutions: command.conflictResolutions ?? [],
            }),
          },
        },
      ];
    }
    case "SplitCatalogMergeCandidate": {
      requireReviewActionable(state);
      const remainingSnapshot = normalizeReviewSnapshot(command.remainingSnapshot);
      const splitSnapshot = normalizeReviewSnapshot(command.splitSnapshot);
      const splitCandidateId = requireText(command.splitCandidateId, "Split Catalog Merge Candidate ID");
      assert(splitCandidateId !== state.id, "Split Catalog Merge Candidate ID must differ from the original.");
      assert(
        remainingSnapshot.membership.length < state.snapshot.membership.length,
        "Split must remove at least one Source Observation from the original candidate.",
      );
      assert(
        splitSnapshot.membership.length > 0,
        "Split Catalog Merge Candidate requires at least one Source Observation.",
      );
      assertNoOverlappingMembership(remainingSnapshot, splitSnapshot);
      assertSameMembership(state.snapshot, [...remainingSnapshot.membership, ...splitSnapshot.membership]);
      const reason = requireText(command.reason, "Split reason");

      return [
        {
          type: "catalog.merge-candidate.split",
          data: {
            candidateId: state.id,
            status: statusForSnapshot(remainingSnapshot),
            remainingSnapshot,
            splitCandidateId,
            splitSnapshot,
            splitAt: command.splitAt,
            audit: actionAudit({
              action: "split",
              actor: command.actor,
              reason,
              decidedAt: command.splitAt,
              beforeSnapshot: state.snapshot,
              afterSnapshot: remainingSnapshot,
              conflictResolutions: command.conflictResolutions ?? [],
            }),
          },
        },
      ];
    }
    case "UpdateCatalogMergeCandidate": {
      requireReviewActionable(state);
      const snapshot = normalizeReviewSnapshot(command.snapshot);
      const reason = requireText(command.reason, "Update reason");

      return [
        {
          type: "catalog.merge-candidate.updated",
          data: {
            candidateId: state.id,
            status: statusForSnapshot(snapshot),
            snapshot,
            updatedAt: command.updatedAt,
            audit: actionAudit({
              action: "update",
              actor: command.actor,
              reason,
              decidedAt: command.updatedAt,
              beforeSnapshot: state.snapshot,
              afterSnapshot: snapshot,
              conflictResolutions: command.conflictResolutions ?? [],
            }),
          },
        },
      ];
    }
    case "IgnoreCatalogMergeCandidate": {
      requireReviewActionable(state);
      const reason = requireText(command.reason, "Ignore reason");

      return [
        {
          type: "catalog.merge-candidate.ignored",
          data: {
            candidateId: state.id,
            ignoredAt: command.ignoredAt,
            audit: actionAudit({
              action: "ignore",
              actor: command.actor,
              reason,
              decidedAt: command.ignoredAt,
              beforeSnapshot: state.snapshot,
              afterSnapshot: state.snapshot,
              conflictResolutions: command.conflictResolutions ?? [],
            }),
          },
        },
      ];
    }
    case "DeferCatalogMergeCandidate": {
      requireReviewActionable(state);
      const reason = requireText(command.reason, "Deferral reason");

      return [
        {
          type: "catalog.merge-candidate.deferred",
          data: {
            candidateId: state.id,
            deferredAt: command.deferredAt,
            audit: actionAudit({
              action: "defer",
              actor: command.actor,
              reason,
              decidedAt: command.deferredAt,
              beforeSnapshot: state.snapshot,
              afterSnapshot: state.snapshot,
              conflictResolutions: command.conflictResolutions ?? [],
            }),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveCatalogMergeCandidate: AggregateEvolver<CatalogMergeCandidateState, CatalogMergeCandidateEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.merge-candidate.created":
      return {
        ...state,
        id: event.data.candidateId,
        status: event.data.status,
        statusReason: null,
        snapshot: event.data.snapshot,
        createdAt: event.data.createdAt,
        updatedAt: event.data.createdAt,
        staleAt: null,
      };
    case "catalog.merge-candidate.refreshed":
      return {
        ...state,
        status: event.data.status,
        statusReason: null,
        snapshot: event.data.snapshot,
        updatedAt: event.data.refreshedAt,
        staleAt: null,
      };
    case "catalog.merge-candidate.marked-stale":
      return {
        ...state,
        status: "stale",
        statusReason: event.data.reason,
        updatedAt: event.data.staleAt,
        staleAt: event.data.staleAt,
      };
    case "catalog.merge-candidate.observation-added":
      return {
        ...state,
        status: "stale",
        statusReason: membershipChangedStatusReason(),
        snapshot: {
          ...requireSnapshot(state),
          membership: normalizeObservationMembership([...requireSnapshot(state).membership, event.data.member]),
        },
        updatedAt: event.data.updatedAt,
        staleAt: event.data.updatedAt,
      };
    case "catalog.merge-candidate.observation-removed":
      return {
        ...state,
        status: "stale",
        statusReason: membershipChangedStatusReason(event.data.reason),
        snapshot: {
          ...requireSnapshot(state),
          membership: requireSnapshot(state).membership.filter(
            (member) => member.observationId !== event.data.observationId,
          ),
        },
        updatedAt: event.data.removedAt,
        staleAt: event.data.removedAt,
      };
    case "catalog.merge-candidate.promoted":
      return {
        ...state,
        status: "promoted",
        statusReason: promotedStatusReason(event.data.audit.reason),
        updatedAt: event.data.promotedAt,
        staleAt: null,
      };
    case "catalog.merge-candidate.split":
      return {
        ...state,
        status: event.data.status,
        statusReason: `Candidate split: ${event.data.audit.reason}`,
        snapshot: event.data.remainingSnapshot,
        updatedAt: event.data.splitAt,
        staleAt: null,
      };
    case "catalog.merge-candidate.updated":
      return {
        ...state,
        status: event.data.status,
        statusReason: `Candidate updated: ${event.data.audit.reason}`,
        snapshot: event.data.snapshot,
        updatedAt: event.data.updatedAt,
        staleAt: null,
      };
    case "catalog.merge-candidate.ignored":
      return {
        ...state,
        status: "rejected",
        statusReason: `Candidate ignored: ${event.data.audit.reason}`,
        updatedAt: event.data.ignoredAt,
        staleAt: null,
      };
    case "catalog.merge-candidate.deferred":
      return {
        ...state,
        status: "deferred",
        statusReason: event.data.audit.reason,
        updatedAt: event.data.deferredAt,
        staleAt: null,
      };
    default:
      return assertNever(event);
  }
};

function requireRefreshable(state: CatalogMergeCandidateState): asserts state is CatalogMergeCandidateState & {
  id: string;
  snapshot: CatalogMergeCandidateReviewSnapshot;
} {
  assert(state.id !== null && state.snapshot !== null, "Catalog Merge Candidate must be created first.");
  assert(
    state.status !== "promoted" && state.status !== "rejected",
    "Terminal Catalog Merge Candidates cannot be changed.",
  );
}

function requireReviewActionable(state: CatalogMergeCandidateState): asserts state is CatalogMergeCandidateState & {
  id: string;
  snapshot: CatalogMergeCandidateReviewSnapshot;
} {
  requireRefreshable(state);
}

function requireSnapshot(state: CatalogMergeCandidateState): CatalogMergeCandidateReviewSnapshot {
  assert(state.snapshot !== null, "Catalog Merge Candidate must be created first.");
  return state.snapshot;
}

function normalizeReviewSnapshot(snapshot: CatalogMergeCandidateReviewSnapshot): CatalogMergeCandidateReviewSnapshot {
  const normalized: CatalogMergeCandidateReviewSnapshot = {
    identityFingerprint: requireText(snapshot.identityFingerprint, "Catalog Merge Candidate identity fingerprint"),
    syncRunIds: normalizeOptionalTextList(snapshot.syncRunIds ?? [], "Catalog sync run ID"),
    identity: normalizeIdentity(snapshot.identity),
    membership: normalizeObservationMembership(snapshot.membership),
    matches: {
      catalogItemId: snapshot.matches.catalogItemId?.trim() || null,
      productIds: normalizeTextList(snapshot.matches.productIds, "Matched Product ID"),
    },
    proposedCatalogItemFacts: snapshot.proposedCatalogItemFacts,
    proposedExternalCatalogItemReferences: normalizeExternalCatalogItemReferences(
      snapshot.proposedExternalCatalogItemReferences,
    ),
    proposedExternalProductReferences: normalizeExternalProductReferences(snapshot.proposedExternalProductReferences),
    conflicts: normalizeConflicts(snapshot.conflicts),
    warnings: normalizeWarnings(snapshot.warnings),
    fieldProvenance: normalizeFieldProvenance(snapshot.fieldProvenance),
    promotionIntent: snapshot.promotionIntent,
  };

  assert(
    normalized.promotionIntent === "create-catalog-item" ||
      normalized.promotionIntent === "update-catalog-item" ||
      normalized.promotionIntent === "link-existing-catalog-item",
    "Catalog Merge Candidate promotion intent is not supported.",
  );

  return normalized;
}

function normalizeIdentity(identity: CatalogMergeCandidateIdentity): CatalogMergeCandidateIdentity {
  return {
    scopeRecordId: requireText(identity.scopeRecordId, "Catalog Merge Candidate scope record ID"),
    collectorNumber: identity.collectorNumber?.trim() || null,
    languageCode: requireText(identity.languageCode, "Catalog Merge Candidate language code").toLowerCase(),
    productForm: identity.productForm?.trim() || null,
    variantKey: identity.variantKey?.trim() || null,
    barcode: identity.barcode?.trim() || null,
  };
}

function normalizeObservationMembership(
  membership: readonly CatalogMergeCandidateObservationMember[],
): CatalogMergeCandidateObservationMember[] {
  const normalized = membership.map(normalizeObservationMember);
  assert(normalized.length > 0, "Catalog Merge Candidates require at least one Source Observation.");
  ensureUniqueBy(normalized, (member) => member.observationId, "Catalog Merge Candidate observations must be unique.");
  return normalized.sort((left, right) => left.observationId.localeCompare(right.observationId));
}

function normalizeObservationMember(
  member: CatalogMergeCandidateObservationMember,
): CatalogMergeCandidateObservationMember {
  return {
    observationId: requireText(member.observationId, "Source Observation ID"),
    syncRunId: member.syncRunId?.trim() || null,
    providerKey: requireText(member.providerKey, "Source Observation provider key").toLowerCase(),
    externalKey: requireText(member.externalKey, "Source Observation external key"),
    sourceRecordHash: requireText(member.sourceRecordHash, "Source Observation source record hash"),
    sourceProfileKey: requireText(member.sourceProfileKey, "Source Observation source profile key").toLowerCase(),
    sourceProfileVersion: requireText(member.sourceProfileVersion, "Source Observation source profile version"),
    sourceMappingFingerprint: requireText(
      member.sourceMappingFingerprint,
      "Source Observation source mapping fingerprint",
    ),
    observedAt: requireText(member.observedAt, "Source Observation observed timestamp"),
    addedAt: requireText(member.addedAt, "Catalog Merge Candidate membership timestamp"),
  };
}

function normalizeExternalCatalogItemReferences(
  references: readonly CatalogMergeCandidateExternalCatalogItemReference[],
): CatalogMergeCandidateExternalCatalogItemReference[] {
  const normalized = references.map((reference) => ({
    providerKey: requireText(reference.providerKey, "External Catalog Item Reference provider key").toLowerCase(),
    externalKey: requireText(reference.externalKey, "External Catalog Item Reference external key"),
  }));
  ensureUniqueBy(
    normalized,
    (reference) => `${reference.providerKey}:${reference.externalKey}`,
    "External Catalog Item References must be unique.",
  );
  return normalized;
}

function normalizeExternalProductReferences(
  references: readonly CatalogMergeCandidateExternalProductReference[],
): CatalogMergeCandidateExternalProductReference[] {
  const normalized = references.map((reference) => ({
    providerKey: requireText(reference.providerKey, "External Product Reference provider key").toLowerCase(),
    externalKey: requireText(reference.externalKey, "External Product Reference external key"),
    selectedOptions: reference.selectedOptions.map((option) => ({
      dimensionId: requireText(option.dimensionId, "Selected Option dimension ID"),
      optionId: requireText(option.optionId, "Selected Option option ID"),
    })),
    reviewEvidence: reference.reviewEvidence ?? null,
  }));
  ensureUniqueBy(
    normalized,
    (reference) => `${reference.providerKey}:${reference.externalKey}`,
    "External Product References must be unique.",
  );
  return normalized;
}

function normalizeConflicts(conflicts: readonly CatalogMergeCandidateConflict[]): CatalogMergeCandidateConflict[] {
  return conflicts.map((conflict) => {
    assert(
      conflict.severity === "blocking" || conflict.severity === "warning",
      "Catalog Merge Candidate conflict severity is not supported.",
    );
    return {
      code: requireText(conflict.code, "Conflict code"),
      severity: conflict.severity,
      message: requireText(conflict.message, "Conflict message"),
      fieldPath: conflict.fieldPath?.trim() || null,
      observationIds: normalizeObservationIds(conflict.observationIds),
      existingValue: conflict.existingValue,
      proposedValue: conflict.proposedValue,
    };
  });
}

function normalizeWarnings(warnings: readonly CatalogMergeCandidateWarning[]): CatalogMergeCandidateWarning[] {
  return warnings.map((warning) => ({
    code: requireText(warning.code, "Warning code"),
    message: requireText(warning.message, "Warning message"),
    fieldPath: warning.fieldPath?.trim() || null,
    observationIds: normalizeObservationIds(warning.observationIds),
  }));
}

function normalizeFieldProvenance(
  provenance: readonly CatalogMergeCandidateFieldProvenance[],
): CatalogMergeCandidateFieldProvenance[] {
  return provenance.map((entry) => {
    assert(
      entry.confidence === "exact" ||
        entry.confidence === "high" ||
        entry.confidence === "candidate" ||
        entry.confidence === "manual",
      "Catalog Merge Candidate field provenance confidence is not supported.",
    );
    return {
      fieldPath: requireText(entry.fieldPath, "Field provenance path"),
      value: entry.value,
      observationId: requireText(entry.observationId, "Field provenance Source Observation ID"),
      providerKey: requireText(entry.providerKey, "Field provenance provider key").toLowerCase(),
      sourceProfileKey: requireText(entry.sourceProfileKey, "Field provenance source profile key").toLowerCase(),
      sourceProfileVersion: requireText(entry.sourceProfileVersion, "Field provenance source profile version"),
      confidence: entry.confidence,
      evidence: entry.evidence,
    };
  });
}

function normalizeReviewActor(actor: CatalogMergeCandidateReviewActor): CatalogMergeCandidateReviewActor {
  return {
    userId: actor.userId?.trim() || null,
    accountId: actor.accountId?.trim() || null,
  };
}

function normalizeConflictResolutions(
  resolutions: readonly CatalogMergeCandidateConflictResolution[],
): CatalogMergeCandidateConflictResolution[] {
  return resolutions.map((resolution) => ({
    conflictCode: requireText(resolution.conflictCode, "Conflict resolution code"),
    fieldPath: resolution.fieldPath?.trim() || null,
    chosenValue: resolution.chosenValue,
    reason: requireText(resolution.reason, "Conflict resolution reason"),
    observationIds: normalizeObservationIds(resolution.observationIds),
  }));
}

function actionAudit(input: {
  action: CatalogMergeCandidateActionAudit["action"];
  actor: CatalogMergeCandidateReviewActor;
  reason: string;
  decidedAt: string;
  beforeSnapshot: CatalogMergeCandidateReviewSnapshot;
  afterSnapshot: CatalogMergeCandidateReviewSnapshot;
  conflictResolutions: readonly CatalogMergeCandidateConflictResolution[];
}): CatalogMergeCandidateActionAudit {
  return {
    action: input.action,
    actor: normalizeReviewActor(input.actor),
    reason: requireText(input.reason, "Candidate action reason"),
    decidedAt: requireText(input.decidedAt, "Candidate action timestamp"),
    beforeIdentity: input.beforeSnapshot.identity,
    afterIdentity: input.afterSnapshot.identity,
    membershipChanges: membershipChanges(input.beforeSnapshot, input.afterSnapshot),
    conflictResolutions: normalizeConflictResolutions(input.conflictResolutions),
  };
}

function membershipChanges(
  beforeSnapshot: CatalogMergeCandidateReviewSnapshot,
  afterSnapshot: CatalogMergeCandidateReviewSnapshot,
): CatalogMergeCandidateMembershipChanges {
  const beforeIds = beforeSnapshot.membership.map((member) => member.observationId);
  const afterIds = afterSnapshot.membership.map((member) => member.observationId);
  return {
    addedObservationIds: afterIds.filter((observationId) => !beforeIds.includes(observationId)).sort(),
    removedObservationIds: beforeIds.filter((observationId) => !afterIds.includes(observationId)).sort(),
  };
}

function requireConflictResolutionsForBlockingConflicts(
  state: CatalogMergeCandidateState & { snapshot: CatalogMergeCandidateReviewSnapshot },
  resolutions: readonly CatalogMergeCandidateConflictResolution[],
): void {
  const blockingConflicts = state.snapshot.conflicts.filter((conflict) => conflict.severity === "blocking");
  if (blockingConflicts.length === 0) {
    return;
  }

  const resolvedCodes = new Set(resolutions.map((resolution) => resolution.conflictCode.trim()).filter(Boolean));
  for (const conflict of blockingConflicts) {
    assert(
      resolvedCodes.has(conflict.code),
      "Blocking Catalog Merge Candidate conflicts require review resolutions before promotion.",
    );
  }
}

function assertNoOverlappingMembership(
  left: CatalogMergeCandidateReviewSnapshot,
  right: CatalogMergeCandidateReviewSnapshot,
): void {
  const leftIds = new Set(left.membership.map((member) => member.observationId));
  assert(
    right.membership.every((member) => !leftIds.has(member.observationId)),
    "Split Catalog Merge Candidate membership cannot overlap the original candidate.",
  );
}

function assertSameMembership(
  beforeSnapshot: CatalogMergeCandidateReviewSnapshot,
  afterMembership: readonly CatalogMergeCandidateObservationMember[],
): void {
  const beforeIds = beforeSnapshot.membership.map((member) => member.observationId).sort();
  const afterIds = afterMembership.map((member) => member.observationId).sort();
  assert(
    beforeIds.length === afterIds.length &&
      beforeIds.every((observationId, index) => observationId === afterIds[index]),
    "Split Catalog Merge Candidate membership must preserve every Source Observation.",
  );
}

function statusForSnapshot(
  snapshot: CatalogMergeCandidateReviewSnapshot,
): Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts"> {
  return snapshot.conflicts.some((conflict) => conflict.severity === "blocking") ? "has-conflicts" : "ready";
}

function promotedStatusReason(reason: string): string {
  return `Candidate accepted for Catalog promotion planning: ${reason}`;
}

function membershipChangedStatusReason(reason?: string): string {
  const suffix = reason?.trim();
  return suffix
    ? `Source Observation membership changed: ${suffix}`
    : "Source Observation membership changed; refresh candidate before review.";
}

function normalizeObservationIds(observationIds: readonly string[]): string[] {
  return normalizeTextList(observationIds, "Source Observation ID");
}

function normalizeTextList(values: readonly string[], label: string): string[] {
  const normalized = [...new Set(values.map((value) => requireText(value, label)))];
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeOptionalTextList(values: readonly string[], label: string): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  assert(
    normalized.every((value) => value.toLowerCase() !== "legacy"),
    `${label} cannot use the retired legacy marker.`,
  );
  return normalized.sort((left, right) => left.localeCompare(right));
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  assert(trimmed.length > 0, `${label} is required.`);
  return trimmed;
}
