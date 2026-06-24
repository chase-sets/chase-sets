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
    tcg: string | null;
    productLineName: string;
    setName: string | null;
    printedProductName: string;
    collectorNumber: string | null;
    languageCode: string;
    productForm: string | null;
    variantKey: string | null;
    barcode: string | null;
  }>;

export type CatalogMergeCandidateObservationMember = JsonObject &
  Readonly<{
    observationId: string;
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

export type CatalogMergeCandidateReviewSnapshot = JsonObject &
  Readonly<{
    identityFingerprint: string;
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

export type CatalogMergeCandidateCommand =
  | CreateCatalogMergeCandidateCommand
  | RefreshCatalogMergeCandidateCommand
  | MarkCatalogMergeCandidateStaleCommand
  | AddObservationToCatalogMergeCandidateCommand
  | RemoveObservationFromCatalogMergeCandidateCommand;

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

export type CatalogMergeCandidateEvent =
  | CatalogMergeCandidateCreatedEvent
  | CatalogMergeCandidateRefreshedEvent
  | CatalogMergeCandidateMarkedStaleEvent
  | CatalogMergeCandidateObservationAddedEvent
  | CatalogMergeCandidateObservationRemovedEvent;

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

function requireSnapshot(state: CatalogMergeCandidateState): CatalogMergeCandidateReviewSnapshot {
  assert(state.snapshot !== null, "Catalog Merge Candidate must be created first.");
  return state.snapshot;
}

function normalizeReviewSnapshot(snapshot: CatalogMergeCandidateReviewSnapshot): CatalogMergeCandidateReviewSnapshot {
  const normalized: CatalogMergeCandidateReviewSnapshot = {
    identityFingerprint: requireText(snapshot.identityFingerprint, "Catalog Merge Candidate identity fingerprint"),
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
    tcg: identity.tcg?.trim().toLowerCase() || null,
    productLineName: requireText(identity.productLineName, "Catalog Merge Candidate product line name"),
    setName: identity.setName?.trim() || null,
    printedProductName: requireText(identity.printedProductName, "Catalog Merge Candidate printed product name"),
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

function statusForSnapshot(
  snapshot: CatalogMergeCandidateReviewSnapshot,
): Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts"> {
  return snapshot.conflicts.some((conflict) => conflict.severity === "blocking") ? "has-conflicts" : "ready";
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

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  assert(trimmed.length > 0, `${label} is required.`);
  return trimmed;
}
