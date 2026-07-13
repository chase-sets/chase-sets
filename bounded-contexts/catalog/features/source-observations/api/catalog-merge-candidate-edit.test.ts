import { describe, expect, it } from "vitest";
import {
  applyCatalogMergeCandidateEdit,
  catalogMergeCandidateEditFormFor,
  catalogMergeCandidateEditInputFromFormData,
  editedSnapshotFromFormData,
} from "./catalog-merge-candidate-edit";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateObservationMember,
  type CatalogMergeCandidateReviewSnapshot,
  type CatalogMergeCandidateState,
} from "../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../read-model/queries";

function member(
  overrides: Partial<CatalogMergeCandidateObservationMember> = {},
): CatalogMergeCandidateObservationMember {
  return {
    observationId: "obs_tcgplayer_base1_004",
    syncRunId: "run_1",
    providerKey: "tcgplayer",
    externalKey: "tcgplayer:base1-004",
    sourceRecordHash: "sha256:record",
    sourceProfileKey: "tcgplayer-pokemon-card",
    sourceProfileVersion: "2026.06.24",
    sourceMappingFingerprint: "sha256:mapping",
    observedAt: "2026-06-24T09:00:00.000Z",
    addedAt: "2026-06-24T09:30:00.000Z",
    ...overrides,
  };
}

function baseSnapshot(
  overrides: Partial<CatalogMergeCandidateReviewSnapshot> = {},
): CatalogMergeCandidateReviewSnapshot {
  return {
    identityFingerprint: "sha256:cand",
    syncRunIds: ["run_1"],
    identity: {
      scopeRecordId: "scope_base_set",
      collectorNumber: "004",
      languageCode: "en",
      productForm: "card",
      variantKey: null,
      barcode: null,
    },
    membership: [member()],
    matches: { catalogItemId: null, productIds: [] },
    proposedCatalogItemFacts: { name: "Charmander", rarity: "Common" },
    proposedExternalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "tcgplayer:base1-004" }],
    proposedExternalProductReferences: [
      { providerKey: "tcgplayer", externalKey: "tcgplayer:base1-004", selectedOptions: [], reviewEvidence: null },
    ],
    conflicts: [],
    warnings: [],
    fieldProvenance: [
      {
        fieldPath: "catalogItem.name",
        value: "Charmander",
        observationId: "obs_tcgplayer_base1_004",
        providerKey: "tcgplayer",
        sourceProfileKey: "tcgplayer-pokemon-card",
        sourceProfileVersion: "2026.06.24",
        confidence: "exact",
        evidence: {},
      },
    ],
    promotionIntent: "create-catalog-item",
    ...overrides,
  };
}

function listRow(overrides: Partial<CatalogMergeCandidateListRow> = {}): CatalogMergeCandidateListRow {
  const snapshot = baseSnapshot();
  return {
    candidate_id: "cand_1",
    identity_fingerprint: snapshot.identityFingerprint,
    sync_run_ids_json: snapshot.syncRunIds,
    status: "ready",
    status_reason: null,
    identity_json: {
      ...snapshot.identity,
      printedProductName: "Charmander",
      setName: "Base Set",
      productLineName: "Pokemon",
    },
    matched_catalog_item_id: snapshot.matches.catalogItemId,
    matched_product_ids_json: snapshot.matches.productIds,
    proposed_catalog_item_facts_json: snapshot.proposedCatalogItemFacts,
    proposed_external_catalog_item_references_json: snapshot.proposedExternalCatalogItemReferences,
    proposed_external_product_references_json: snapshot.proposedExternalProductReferences,
    conflicts_json: snapshot.conflicts,
    warnings_json: snapshot.warnings,
    field_provenance_json: snapshot.fieldProvenance,
    membership_json: snapshot.membership,
    promotion_intent: snapshot.promotionIntent,
    created_at: "2026-06-24T09:30:00.000Z",
    updated_at: "2026-06-24T09:30:00.000Z",
    stale_at: null,
    observation_count: 1,
    ...overrides,
  };
}

function createdState(): CatalogMergeCandidateState {
  const created = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
    type: "CreateCatalogMergeCandidate",
    candidateId: "cand_1",
    snapshot: baseSnapshot(),
    createdAt: "2026-06-24T09:30:00.000Z",
  })[0];
  return evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, created);
}

describe("applyCatalogMergeCandidateEdit", () => {
  it("records a field override as manual provenance and carries the edited value", () => {
    const edited = applyCatalogMergeCandidateEdit(baseSnapshot(), {
      promotionIntent: "create-catalog-item",
      catalogItemId: null,
      productIds: [],
      factOverrides: [{ key: "name", value: "Charmander - corrected" }],
      droppedExternalCatalogItemReferenceIndexes: [],
      droppedExternalProductReferenceIndexes: [],
    });

    expect(edited.proposedCatalogItemFacts.name).toBe("Charmander - corrected");
    const manual = edited.fieldProvenance.find((entry) => entry.fieldPath === "catalogItem.name");
    expect(manual).toMatchObject({
      confidence: "manual",
      value: "Charmander - corrected",
      observationId: "obs_tcgplayer_base1_004",
      evidence: { operatorCorrection: true },
    });
    // No duplicate provenance entry for the same field path.
    expect(edited.fieldProvenance.filter((entry) => entry.fieldPath === "catalogItem.name")).toHaveLength(1);
  });

  it("switches promotion intent and edits the product mapping", () => {
    const edited = applyCatalogMergeCandidateEdit(baseSnapshot(), {
      promotionIntent: "link-existing-catalog-item",
      catalogItemId: "cat_charmander",
      productIds: ["prod_a", "prod_b", "prod_a"],
      factOverrides: [],
      droppedExternalCatalogItemReferenceIndexes: [],
      droppedExternalProductReferenceIndexes: [],
    });

    expect(edited.promotionIntent).toBe("link-existing-catalog-item");
    expect(edited.matches).toEqual({ catalogItemId: "cat_charmander", productIds: ["prod_a", "prod_b"] });
  });

  it("drops proposed external references by index", () => {
    const edited = applyCatalogMergeCandidateEdit(baseSnapshot(), {
      promotionIntent: "create-catalog-item",
      catalogItemId: null,
      productIds: [],
      factOverrides: [],
      droppedExternalCatalogItemReferenceIndexes: [0],
      droppedExternalProductReferenceIndexes: [0],
    });

    expect(edited.proposedExternalCatalogItemReferences).toHaveLength(0);
    expect(edited.proposedExternalProductReferences).toHaveLength(0);
  });

  it("produces a snapshot the domain accepts, and promotion carries the edited value with manual provenance", () => {
    const edited = applyCatalogMergeCandidateEdit(baseSnapshot(), {
      promotionIntent: "create-catalog-item",
      catalogItemId: null,
      productIds: [],
      factOverrides: [{ key: "name", value: "Charmander - corrected" }],
      droppedExternalCatalogItemReferenceIndexes: [],
      droppedExternalProductReferenceIndexes: [],
    });

    const updateEvent = decideCatalogMergeCandidate(createdState(), {
      type: "UpdateCatalogMergeCandidate",
      snapshot: edited,
      reason: "Operator corrected the printed name before promotion.",
      actor: { userId: "user_1", accountId: null },
      updatedAt: "2026-06-24T10:00:00.000Z",
    })[0];
    const updatedState = evolveCatalogMergeCandidate(createdState(), updateEvent);

    expect(updatedState.snapshot?.proposedCatalogItemFacts.name).toBe("Charmander - corrected");
    expect(updatedState.snapshot?.fieldProvenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldPath: "catalogItem.name", confidence: "manual" })]),
    );

    // The corrected value survives to promotion, which carries the current snapshot.
    const promoteEvent = decideCatalogMergeCandidate(updatedState, {
      type: "PromoteCatalogMergeCandidate",
      reason: "Promote the corrected candidate.",
      actor: { userId: "user_1", accountId: null },
      promotedAt: "2026-06-24T10:05:00.000Z",
    })[0];
    expect(promoteEvent.type).toBe("catalog.merge-candidate.promoted");
    expect(updatedState.snapshot?.proposedCatalogItemFacts.name).toBe("Charmander - corrected");
  });
});

describe("catalogMergeCandidateEditFormFor", () => {
  it("exposes the editable surface for an actionable candidate", () => {
    const editForm = catalogMergeCandidateEditFormFor(listRow(), { canManage: true });

    expect(editForm.editable).toBe(true);
    expect(editForm.baseSnapshotJson).not.toBeNull();
    expect(editForm.editableFacts.map((fact) => fact.key)).toEqual(["name", "rarity"]);
    expect(editForm.externalCatalogItemReferences).toEqual([{ index: 0, label: "tcgplayer:tcgplayer:base1-004" }]);
  });

  it("is not editable without manage permission", () => {
    const editForm = catalogMergeCandidateEditFormFor(listRow(), { canManage: false });
    expect(editForm.editable).toBe(false);
    expect(editForm.baseSnapshotJson).toBeNull();
  });

  it("is not editable for terminal candidates", () => {
    const editForm = catalogMergeCandidateEditFormFor(listRow({ status: "promoted" }), { canManage: true });
    expect(editForm.editable).toBe(false);
    expect(editForm.baseSnapshotJson).toBeNull();
  });
});

describe("catalogMergeCandidateEditInputFromFormData / editedSnapshotFromFormData", () => {
  it("only records facts the operator actually changed", () => {
    const formData = new FormData();
    formData.set("candidateEditPromotionIntent", "create-catalog-item");
    formData.set("candidateEditFact.name", "Charmander - corrected");
    formData.set("candidateEditFact.rarity", "Common"); // unchanged

    const input = catalogMergeCandidateEditInputFromFormData(baseSnapshot(), formData);
    expect(input.factOverrides).toEqual([{ key: "name", value: "Charmander - corrected" }]);
  });

  it("reconstructs the edited snapshot from the embedded base and overrides", () => {
    const formData = new FormData();
    formData.set("candidateEditBaseSnapshot", JSON.stringify(baseSnapshot()));
    formData.set("candidateEditPromotionIntent", "update-catalog-item");
    formData.set("candidateEditCatalogItemId", "cat_charmander");
    formData.set("candidateEditFact.name", "Charmander - corrected");
    formData.set("candidateEditDropProductRef.0", "on");

    const snapshot = editedSnapshotFromFormData(formData);
    expect(snapshot?.promotionIntent).toBe("update-catalog-item");
    expect(snapshot?.matches.catalogItemId).toBe("cat_charmander");
    expect(snapshot?.proposedCatalogItemFacts.name).toBe("Charmander - corrected");
    expect(snapshot?.proposedExternalProductReferences).toHaveLength(0);
  });

  it("returns null when no base snapshot was posted", () => {
    expect(editedSnapshotFromFormData(new FormData())).toBeNull();
  });
});
