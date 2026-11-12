import type { JsonObject } from "@chase-sets/primitives/json";
import type {
  CatalogMergeCandidateExternalCatalogItemReference,
  CatalogMergeCandidateExternalProductReference,
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidateObservationMember,
  CatalogMergeCandidateReviewSnapshot,
} from "../../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../../read-model/queries";

export type CatalogMergeCandidateReviewCommandKey = "candidate.promote" | "candidate.split" | "candidate.edit";

export type CatalogMergeCandidateReviewCommandPreview =
  | CatalogMergeCandidatePromoteCommandPreview
  | CatalogMergeCandidateSplitCommandPreview
  | CatalogMergeCandidateUpdateProductMappingCommandPreview;

export type CatalogMergeCandidateReviewCommandPreviewResult =
  | Readonly<{
      status: "available";
      preview: CatalogMergeCandidateReviewCommandPreview;
      blockers: readonly [];
    }>
  | Readonly<{
      status: "blocked";
      preview: null;
      blockers: readonly CatalogMergeCandidateReviewCommandBlocker[];
    }>;

export type CatalogMergeCandidateReviewCommandBlocker =
  | "candidate-terminal"
  | "candidate-stale"
  | "missing-membership-provenance"
  | "split-requires-two-members"
  | "split-requires-separable-reference-provenance"
  | "update-requires-product-mapping";

export type CatalogMergeCandidateReviewCommandProvenance = Readonly<{
  source: "catalog-merge-candidate-review-row";
  candidateId: string;
  identityFingerprint: string;
  membership: readonly CatalogMergeCandidateObservationMember[];
  fieldProvenance: readonly CatalogMergeCandidateFieldProvenance[];
  externalCatalogItemReferences: readonly CatalogMergeCandidateExternalCatalogItemReference[];
  externalProductReferences: readonly CatalogMergeCandidateExternalProductReference[];
}>;

export type CatalogMergeCandidatePromoteCommandPreview = Readonly<{
  commandKind: "promote-catalog-merge-candidate";
  commandKey: "candidate.promote";
  route: Readonly<{
    method: "POST";
    path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/promote";
    candidateId: string;
  }>;
  body: Readonly<{ reason: string; expectedVersion: number }>;
  provenance: CatalogMergeCandidateReviewCommandProvenance;
}>;

export type CatalogMergeCandidateUpdateProductMappingCommandPreview = Readonly<{
  commandKind: "update-catalog-merge-candidate-product-mapping";
  commandKey: "candidate.edit";
  route: Readonly<{
    method: "POST";
    path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/update";
    candidateId: string;
  }>;
  // The request the update route takes: an empty edit keeps the candidate's mapping as it is.
  body: Readonly<{
    reason: string;
    expectedVersion: number;
    edit: Readonly<Record<string, never>>;
  }>;
  preview: Readonly<{
    productReferenceCount: number;
    selectedOptionCount: number;
    matchedProductIds: readonly string[];
  }>;
  provenance: CatalogMergeCandidateReviewCommandProvenance;
}>;

export type CatalogMergeCandidateSplitCommandPreview = Readonly<{
  commandKind: "split-catalog-merge-candidate-by-source-membership";
  commandKey: "candidate.split";
  route: Readonly<{
    method: "POST";
    path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/split";
    candidateId: string;
  }>;
  // The request the split route takes: the Catalog API builds both snapshots itself.
  body: Readonly<{
    reason: string;
    expectedVersion: number;
    splitObservationIds: readonly string[];
  }>;
  preview: Readonly<{
    remainingObservationIds: readonly string[];
    splitObservationIds: readonly string[];
    remainingProductReferenceCount: number;
    splitProductReferenceCount: number;
  }>;
  provenance: CatalogMergeCandidateReviewCommandProvenance;
}>;

const updateReason = "Update Product mapping from the scope-first Catalog sync workbench.";
const splitReason = "Split candidate from the scope-first Catalog sync workbench.";

export function previewCatalogMergeCandidateReviewCommand(
  candidate: CatalogMergeCandidateListRow,
  commandKey: CatalogMergeCandidateReviewCommandKey,
): CatalogMergeCandidateReviewCommandPreviewResult {
  const blockers = actionableBlockers(candidate);
  if (blockers.length > 0) {
    return { status: "blocked", preview: null, blockers };
  }

  if (commandKey === "candidate.promote") {
    return {
      status: "available",
      blockers: [],
      preview: {
        commandKind: "promote-catalog-merge-candidate",
        commandKey,
        route: {
          method: "POST",
          path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/promote",
          candidateId: candidate.candidate_id,
        },
        body: {
          reason: "Promote from the scope-first Catalog sync workbench.",
          expectedVersion: candidate.last_stream_version,
        },
        provenance: commandProvenance(candidate),
      },
    };
  }

  const snapshot = snapshotFromReviewRow(candidate);
  if (!snapshot) {
    return { status: "blocked", preview: null, blockers: ["missing-membership-provenance"] };
  }

  if (commandKey === "candidate.edit") {
    if (snapshot.proposedExternalProductReferences.length === 0) {
      return { status: "blocked", preview: null, blockers: ["update-requires-product-mapping"] };
    }

    return {
      status: "available",
      blockers: [],
      preview: {
        commandKind: "update-catalog-merge-candidate-product-mapping",
        commandKey,
        route: {
          method: "POST",
          path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/update",
          candidateId: candidate.candidate_id,
        },
        body: {
          reason: updateReason,
          expectedVersion: candidate.last_stream_version,
          edit: {},
        },
        preview: {
          productReferenceCount: snapshot.proposedExternalProductReferences.length,
          selectedOptionCount: snapshot.proposedExternalProductReferences.reduce(
            (total, reference) => total + reference.selectedOptions.length,
            0,
          ),
          matchedProductIds: [...snapshot.matches.productIds],
        },
        provenance: commandProvenance(candidate),
      },
    };
  }

  return previewSplitCommand(candidate, snapshot);
}

export function snapshotFromReviewRow(
  candidate: CatalogMergeCandidateListRow,
): CatalogMergeCandidateReviewSnapshot | null {
  if (candidate.membership_json.length === 0) {
    return null;
  }

  return {
    identityFingerprint: candidate.identity_fingerprint,
    syncRunIds: [...candidate.sync_run_ids_json],
    identity: candidate.identity_json,
    membership: [...candidate.membership_json],
    matches: {
      catalogItemId: candidate.matched_catalog_item_id,
      productIds: [...candidate.matched_product_ids_json],
    },
    proposedCatalogItemFacts: asJsonObject(candidate.proposed_catalog_item_facts_json),
    proposedExternalCatalogItemReferences: [...candidate.proposed_external_catalog_item_references_json],
    proposedExternalProductReferences: [...candidate.proposed_external_product_references_json],
    conflicts: [...candidate.conflicts_json],
    warnings: [...candidate.warnings_json],
    fieldProvenance: [...candidate.field_provenance_json],
    promotionIntent: candidate.promotion_intent,
  };
}

/** The two snapshots and the new candidate's id a split of `splitObservationIds` off a candidate makes. */
export type CatalogMergeCandidateSplitPlan = Readonly<{
  remainingSnapshot: CatalogMergeCandidateReviewSnapshot;
  splitCandidateId: string;
  splitSnapshot: CatalogMergeCandidateReviewSnapshot;
}>;

export type CatalogMergeCandidateSplitBlocker = Extract<
  CatalogMergeCandidateReviewCommandBlocker,
  "split-requires-two-members" | "split-requires-separable-reference-provenance"
>;

/**
 * Split `splitObservationIds` off the candidate whose stored snapshot is `snapshot`. The Catalog
 * API builds both snapshots and the split candidate's id from the snapshot it holds, so a client
 * names only the Source Observations to split off. They must be members, and some member must
 * remain; each side keeps the references, provenance, conflicts and warnings of its own members,
 * and each needs at least one reference of its own.
 */
export function planCatalogMergeCandidateSplit(
  candidateId: string,
  snapshot: CatalogMergeCandidateReviewSnapshot,
  splitObservationIds: readonly string[],
):
  | Readonly<{ ok: true; plan: CatalogMergeCandidateSplitPlan }>
  | Readonly<{ ok: false; blocker: CatalogMergeCandidateSplitBlocker | "split-selection-invalid" }> {
  const memberIds = new Set(snapshot.membership.map((member) => member.observationId));
  const splitIds = new Set(splitObservationIds.map((id) => id.trim()).filter(Boolean));
  if (splitIds.size === 0 || [...splitIds].some((id) => !memberIds.has(id))) {
    return { ok: false, blocker: "split-selection-invalid" };
  }
  const splitMembers = snapshot.membership.filter((member) => splitIds.has(member.observationId));
  const remainingMembers = snapshot.membership.filter((member) => !splitIds.has(member.observationId));
  if (remainingMembers.length === 0) {
    return { ok: false, blocker: "split-requires-two-members" };
  }

  const remainingSnapshot = splitSnapshotForMembers(snapshot, remainingMembers, "remaining");
  const splitSnapshot = splitSnapshotForMembers(snapshot, splitMembers, "split");
  if (referenceCount(remainingSnapshot) === 0 || referenceCount(splitSnapshot) === 0) {
    return { ok: false, blocker: "split-requires-separable-reference-provenance" };
  }

  return {
    ok: true,
    plan: {
      remainingSnapshot,
      splitCandidateId: splitCandidateIdFor(candidateId, splitMembers),
      splitSnapshot,
    },
  };
}

function referenceCount(snapshot: CatalogMergeCandidateReviewSnapshot): number {
  return snapshot.proposedExternalCatalogItemReferences.length + snapshot.proposedExternalProductReferences.length;
}

// Named by the observations split off, in id order, so the same selection gives the same id (one
// observation keeps the id the workbench always gave it).
function splitCandidateIdFor(
  candidateId: string,
  splitMembers: readonly CatalogMergeCandidateObservationMember[],
): string {
  const ids = splitMembers.map((member) => safeIdentifier(member.observationId)).sort();
  return `${candidateId}__split__${ids.join("__")}`;
}

// The workbench offers a split for a candidate of two members: the second (in membership order)
// is split off.
function previewSplitCommand(
  candidate: CatalogMergeCandidateListRow,
  snapshot: CatalogMergeCandidateReviewSnapshot,
): CatalogMergeCandidateReviewCommandPreviewResult {
  const splitMember = snapshot.membership.length === 2 ? snapshot.membership[1] : undefined;
  if (!splitMember) {
    return { status: "blocked", preview: null, blockers: ["split-requires-two-members"] };
  }

  const planned = planCatalogMergeCandidateSplit(candidate.candidate_id, snapshot, [splitMember.observationId]);
  if (!planned.ok) {
    return {
      status: "blocked",
      preview: null,
      blockers: [planned.blocker === "split-selection-invalid" ? "split-requires-two-members" : planned.blocker],
    };
  }
  const { remainingSnapshot, splitSnapshot } = planned.plan;

  return {
    status: "available",
    blockers: [],
    preview: {
      commandKind: "split-catalog-merge-candidate-by-source-membership",
      commandKey: "candidate.split",
      route: {
        method: "POST",
        path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/split",
        candidateId: candidate.candidate_id,
      },
      body: {
        reason: splitReason,
        expectedVersion: candidate.last_stream_version,
        splitObservationIds: [splitMember.observationId],
      },
      preview: {
        remainingObservationIds: remainingSnapshot.membership.map((member) => member.observationId),
        splitObservationIds: splitSnapshot.membership.map((member) => member.observationId),
        remainingProductReferenceCount: remainingSnapshot.proposedExternalProductReferences.length,
        splitProductReferenceCount: splitSnapshot.proposedExternalProductReferences.length,
      },
      provenance: commandProvenance(candidate),
    },
  };
}

function splitSnapshotForMembers(
  snapshot: CatalogMergeCandidateReviewSnapshot,
  members: readonly CatalogMergeCandidateObservationMember[],
  role: "remaining" | "split",
): CatalogMergeCandidateReviewSnapshot {
  const observationIds = new Set(members.map((member) => member.observationId));
  const fieldProvenance = snapshot.fieldProvenance.filter((entry) => observationIds.has(entry.observationId));

  return {
    ...snapshot,
    identityFingerprint: `${snapshot.identityFingerprint}:${role}:${[...observationIds].sort().join(",")}`,
    membership: [...members],
    proposedCatalogItemFacts: factsFromProvenance(fieldProvenance, snapshot.proposedCatalogItemFacts),
    proposedExternalCatalogItemReferences: referencesForMembers(
      snapshot.proposedExternalCatalogItemReferences,
      members,
    ),
    proposedExternalProductReferences: referencesForMembers(snapshot.proposedExternalProductReferences, members),
    conflicts: snapshot.conflicts.filter((conflict) =>
      conflict.observationIds.some((observationId) => observationIds.has(observationId)),
    ),
    warnings: snapshot.warnings.filter((warning) =>
      warning.observationIds.some((observationId) => observationIds.has(observationId)),
    ),
    fieldProvenance,
  };
}

function factsFromProvenance(
  fieldProvenance: readonly CatalogMergeCandidateFieldProvenance[],
  fallback: JsonObject,
): JsonObject {
  const facts: JsonObject = {};
  for (const entry of fieldProvenance) {
    const key = entry.fieldPath.split(".").at(-1)?.trim();
    if (key) {
      facts[key] = entry.value;
    }
  }

  return Object.keys(facts).length > 0 ? facts : fallback;
}

function referencesForMembers<T extends CatalogMergeCandidateExternalCatalogItemReference>(
  references: readonly T[],
  members: readonly CatalogMergeCandidateObservationMember[],
): readonly T[] {
  const keys = new Set(members.map((member) => referenceKey(member.providerKey, member.externalKey)));
  return references.filter((reference) => keys.has(referenceKey(reference.providerKey, reference.externalKey)));
}

function referenceKey(providerKey: string, externalKey: string): string {
  return `${providerKey.trim().toLowerCase()}\u0000${externalKey.trim().toLowerCase()}`;
}

function actionableBlockers(
  candidate: CatalogMergeCandidateListRow,
): readonly Extract<CatalogMergeCandidateReviewCommandBlocker, "candidate-terminal" | "candidate-stale">[] {
  if (candidate.status === "promoted" || candidate.status === "rejected" || candidate.status === "deferred") {
    return ["candidate-terminal"];
  }
  if (candidate.status === "stale") {
    return ["candidate-stale"];
  }
  return [];
}

function commandProvenance(candidate: CatalogMergeCandidateListRow): CatalogMergeCandidateReviewCommandProvenance {
  return {
    source: "catalog-merge-candidate-review-row",
    candidateId: candidate.candidate_id,
    identityFingerprint: candidate.identity_fingerprint,
    membership: [...candidate.membership_json],
    fieldProvenance: [...candidate.field_provenance_json],
    externalCatalogItemReferences: [...candidate.proposed_external_catalog_item_references_json],
    externalProductReferences: [...candidate.proposed_external_product_references_json],
  };
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function safeIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
