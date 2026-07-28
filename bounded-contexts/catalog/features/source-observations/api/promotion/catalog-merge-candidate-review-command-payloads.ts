import type { JsonObject } from "@chase-sets/primitives/json";
import type {
  CatalogMergeCandidateExternalCatalogItemReference,
  CatalogMergeCandidateExternalProductReference,
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidateObservationMember,
  CatalogMergeCandidateReviewSnapshot,
} from "../../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../../read-model/queries";

export type CatalogMergeCandidateReviewCommandKey = "candidate.split" | "candidate.edit";

export type CatalogMergeCandidateReviewCommandPreview =
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

export type CatalogMergeCandidateUpdateProductMappingCommandPreview = Readonly<{
  commandKind: "update-catalog-merge-candidate-product-mapping";
  commandKey: "candidate.edit";
  route: Readonly<{
    method: "POST";
    path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/update";
    candidateId: string;
  }>;
  body: Readonly<{
    reason: string;
    snapshot: CatalogMergeCandidateReviewSnapshot;
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
  body: Readonly<{
    reason: string;
    remainingSnapshot: CatalogMergeCandidateReviewSnapshot;
    splitCandidateId: string;
    splitSnapshot: CatalogMergeCandidateReviewSnapshot;
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
          snapshot,
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

function previewSplitCommand(
  candidate: CatalogMergeCandidateListRow,
  snapshot: CatalogMergeCandidateReviewSnapshot,
): CatalogMergeCandidateReviewCommandPreviewResult {
  if (snapshot.membership.length !== 2) {
    return { status: "blocked", preview: null, blockers: ["split-requires-two-members"] };
  }

  const [remainingMember, splitMember] = snapshot.membership;
  if (!remainingMember || !splitMember) {
    return { status: "blocked", preview: null, blockers: ["split-requires-two-members"] };
  }

  const remainingSnapshot = splitSnapshotForMember(snapshot, remainingMember, "remaining");
  const splitSnapshot = splitSnapshotForMember(snapshot, splitMember, "split");
  if (
    remainingSnapshot.proposedExternalCatalogItemReferences.length +
      remainingSnapshot.proposedExternalProductReferences.length ===
      0 ||
    splitSnapshot.proposedExternalCatalogItemReferences.length +
      splitSnapshot.proposedExternalProductReferences.length ===
      0
  ) {
    return {
      status: "blocked",
      preview: null,
      blockers: ["split-requires-separable-reference-provenance"],
    };
  }

  const splitCandidateId = `${candidate.candidate_id}__split__${safeIdentifier(splitMember.observationId)}`;

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
        remainingSnapshot,
        splitCandidateId,
        splitSnapshot,
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

function splitSnapshotForMember(
  snapshot: CatalogMergeCandidateReviewSnapshot,
  member: CatalogMergeCandidateObservationMember,
  role: "remaining" | "split",
): CatalogMergeCandidateReviewSnapshot {
  const observationIds = new Set([member.observationId]);
  const fieldProvenance = snapshot.fieldProvenance.filter((entry) => observationIds.has(entry.observationId));

  return {
    ...snapshot,
    identityFingerprint: `${snapshot.identityFingerprint}:${role}:${member.observationId}`,
    membership: [member],
    proposedCatalogItemFacts: factsFromProvenance(fieldProvenance, snapshot.proposedCatalogItemFacts),
    proposedExternalCatalogItemReferences: referencesForMember(snapshot.proposedExternalCatalogItemReferences, member),
    proposedExternalProductReferences: referencesForMember(snapshot.proposedExternalProductReferences, member),
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

function referencesForMember<T extends CatalogMergeCandidateExternalCatalogItemReference>(
  references: readonly T[],
  member: CatalogMergeCandidateObservationMember,
): readonly T[] {
  const providerKey = member.providerKey.trim().toLowerCase();
  const externalKey = member.externalKey.trim().toLowerCase();
  return references.filter(
    (reference) =>
      reference.providerKey.trim().toLowerCase() === providerKey &&
      reference.externalKey.trim().toLowerCase() === externalKey,
  );
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
