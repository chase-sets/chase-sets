import { describe, expect, it } from "vitest";
import {
  catalogMergeCandidateEditFormFor,
  catalogMergeCandidateEditRequestFromFormData,
} from "./catalog-merge-candidate-edit";
import type {
  CatalogMergeCandidateObservationMember,
  CatalogMergeCandidateReviewSnapshot,
} from "../../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../../read-model/queries";

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
    last_stream_version: 3,
    stale_at: null,
    observation_count: 1,
    ...overrides,
  };
}

describe("catalogMergeCandidateEditFormFor", () => {
  it("exposes the editable surface for an actionable candidate", () => {
    const editForm = catalogMergeCandidateEditFormFor(listRow(), { canManage: true });

    expect(editForm.editable).toBe(true);
    expect(editForm.candidateVersion).toBe(3);
    expect(editForm.editableFacts.map((fact) => fact.key)).toEqual(["name", "rarity"]);
    expect(editForm.externalCatalogItemReferences).toEqual([{ index: 0, label: "tcgplayer:tcgplayer:base1-004" }]);
  });

  it("is not editable without manage permission", () => {
    const editForm = catalogMergeCandidateEditFormFor(listRow(), { canManage: false });
    expect(editForm.editable).toBe(false);
    expect(editForm.candidateVersion).toBeNull();
  });

  it("is not editable for terminal candidates", () => {
    const editForm = catalogMergeCandidateEditFormFor(listRow({ status: "promoted" }), { canManage: true });
    expect(editForm.editable).toBe(false);
    expect(editForm.candidateVersion).toBeNull();
  });
});

describe("catalogMergeCandidateEditRequestFromFormData", () => {
  it("only records facts the operator changed from the value the page showed", () => {
    const formData = new FormData();
    formData.set("candidateEditPromotionIntent", "create-catalog-item");
    formData.set("candidateEditFact.name", "Charmander - corrected");
    formData.set("candidateEditFactShown.name", "Charmander");
    formData.set("candidateEditFact.rarity", "Common");
    formData.set("candidateEditFactShown.rarity", "Common");

    const request = catalogMergeCandidateEditRequestFromFormData(formData);
    expect(request.factOverrides).toEqual([{ key: "name", value: "Charmander - corrected" }]);
  });

  it("reads the mapping and dropped references", () => {
    const formData = new FormData();
    formData.set("candidateEditPromotionIntent", "update-catalog-item");
    formData.set("candidateEditCatalogItemId", "cat_charmander");
    formData.set("candidateEditProductIds", "prod_b, prod_a, prod_b");
    formData.set("candidateEditFact.name", "Charmander - corrected");
    formData.set("candidateEditFactShown.name", "Charmander");
    formData.set("candidateEditDropProductRef.0", "on");

    const request = catalogMergeCandidateEditRequestFromFormData(formData);
    expect(request).toEqual({
      promotionIntent: "update-catalog-item",
      catalogItemId: "cat_charmander",
      productIds: ["prod_b", "prod_a"],
      factOverrides: [{ key: "name", value: "Charmander - corrected" }],
      droppedExternalCatalogItemReferenceIndexes: [],
      droppedExternalProductReferenceIndexes: [0],
    });
  });

  it("sends an empty edit for a form without the edit fields", () => {
    const request = catalogMergeCandidateEditRequestFromFormData(new FormData());
    expect(request).toEqual({
      factOverrides: [],
      droppedExternalCatalogItemReferenceIndexes: [],
      droppedExternalProductReferenceIndexes: [],
    });
  });
});
