import { describe, expect, it } from "vitest";
import type { CatalogMergeCandidateListRow } from "../read-model/queries";
import { previewCatalogMergeCandidateReviewCommand } from "./catalog-merge-candidate-review-command-payloads";

describe("Catalog Merge Candidate review command payloads", () => {
  it("builds an update Product mapping body from the review row snapshot and provenance", () => {
    const result = previewCatalogMergeCandidateReviewCommand(candidateRow(), "update-merge-candidate");

    expect(result.status).toBe("available");
    if (result.status !== "available") {
      throw new Error("Expected update command preview.");
    }
    if (result.preview.commandKey !== "update-merge-candidate") {
      throw new Error("Expected update command preview.");
    }

    expect(result.preview.commandKind).toBe("update-catalog-merge-candidate-product-mapping");
    expect(result.preview.route).toMatchObject({
      method: "POST",
      path: "/api/catalog/source-observations/admin/merge-candidates/:candidateId/update",
      candidateId: "cand_pokemon_base1_004_standard",
    });
    expect(result.preview.body.snapshot).toMatchObject({
      identityFingerprint: "sha256:candidate-identity",
      membership: [
        expect.objectContaining({ observationId: "obs_tcgdex_004" }),
        expect.objectContaining({ observationId: "obs_tcgplayer_004" }),
      ],
      proposedExternalProductReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "sku:123",
          selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
          reviewEvidence: { source: "tcgplayer-sku" },
        },
      ],
    });
    expect(result.preview.preview).toEqual({
      productReferenceCount: 1,
      selectedOptionCount: 1,
      matchedProductIds: [],
    });
    expect(result.preview.provenance).toMatchObject({
      source: "catalog-merge-candidate-review-row",
      candidateId: "cand_pokemon_base1_004_standard",
      membership: expect.arrayContaining([expect.objectContaining({ providerKey: "tcgdex" })]),
    });
  });

  it("builds a split body only when row membership and references are separable", () => {
    const result = previewCatalogMergeCandidateReviewCommand(candidateRow(), "split-merge-candidate");

    expect(result.status).toBe("available");
    if (result.status !== "available") {
      throw new Error("Expected split command preview.");
    }
    if (result.preview.commandKey !== "split-merge-candidate") {
      throw new Error("Expected split command preview.");
    }

    expect(result.preview.commandKind).toBe("split-catalog-merge-candidate-by-source-membership");
    expect(result.preview.body.splitCandidateId).toBe("cand_pokemon_base1_004_standard__split__obs_tcgplayer_004");
    expect(result.preview.body.remainingSnapshot.membership).toEqual([
      expect.objectContaining({ observationId: "obs_tcgdex_004" }),
    ]);
    expect(result.preview.body.splitSnapshot.membership).toEqual([
      expect.objectContaining({ observationId: "obs_tcgplayer_004" }),
    ]);
    expect(result.preview.body.remainingSnapshot.proposedExternalCatalogItemReferences).toEqual([
      { providerKey: "tcgdex", externalKey: "base1-4" },
    ]);
    expect(result.preview.body.splitSnapshot.proposedExternalProductReferences).toEqual([
      {
        providerKey: "tcgplayer",
        externalKey: "sku:123",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        reviewEvidence: { source: "tcgplayer-sku" },
      },
    ]);
    expect(result.preview.preview).toEqual({
      remainingObservationIds: ["obs_tcgdex_004"],
      splitObservationIds: ["obs_tcgplayer_004"],
      remainingProductReferenceCount: 0,
      splitProductReferenceCount: 1,
    });
  });

  it("fails closed when the review row lacks membership provenance", () => {
    const result = previewCatalogMergeCandidateReviewCommand(
      candidateRow({ membership_json: [] }),
      "update-merge-candidate",
    );

    expect(result).toEqual({
      status: "blocked",
      preview: null,
      blockers: ["missing-membership-provenance"],
    });
  });
});

function candidateRow(overrides: Partial<CatalogMergeCandidateListRow> = {}): CatalogMergeCandidateListRow {
  return {
    candidate_id: "cand_pokemon_base1_004_standard",
    identity_fingerprint: "sha256:candidate-identity",
    sync_run_ids_json: ["sync_001"],
    status: "ready",
    status_reason: null,
    identity_json: {
      scopeRecordId: "scope_pokemon_base_set",
      tcg: "pokemon",
      productLineName: "Pokemon",
      setName: "Base Set",
      printedProductName: "Charizard",
      collectorNumber: "4",
      languageCode: "en",
      productForm: "card",
      variantKey: "standard",
      barcode: null,
    },
    matched_catalog_item_id: null,
    matched_product_ids_json: [],
    proposed_catalog_item_facts_json: {
      name: "Charizard",
      cardNumber: "4",
      rarity: "Rare Holo",
      setName: "Base Set",
    },
    proposed_external_catalog_item_references_json: [{ providerKey: "tcgdex", externalKey: "base1-4" }],
    proposed_external_product_references_json: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:123",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        reviewEvidence: { source: "tcgplayer-sku" },
      },
    ],
    conflicts_json: [],
    warnings_json: [],
    field_provenance_json: [
      {
        fieldPath: "name",
        value: "Charizard",
        observationId: "obs_tcgdex_004",
        providerKey: "tcgdex",
        sourceProfileKey: "tcgdex-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        confidence: "exact",
        evidence: { path: "card.name" },
      },
      {
        fieldPath: "cardNumber",
        value: "4",
        observationId: "obs_tcgplayer_004",
        providerKey: "tcgplayer",
        sourceProfileKey: "tcgplayer-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        confidence: "high",
        evidence: { path: "product.number" },
      },
    ],
    membership_json: [
      {
        observationId: "obs_tcgdex_004",
        syncRunId: "sync_001",
        providerKey: "tcgdex",
        externalKey: "base1-4",
        sourceRecordHash: "sha256:tcgdex-source",
        sourceProfileKey: "tcgdex-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        sourceMappingFingerprint: "sha256:tcgdex-mapping",
        observedAt: "2026-06-09T01:00:00.000Z",
        addedAt: "2026-06-09T01:02:00.000Z",
      },
      {
        observationId: "obs_tcgplayer_004",
        syncRunId: "sync_001",
        providerKey: "tcgplayer",
        externalKey: "sku:123",
        sourceRecordHash: "sha256:tcgplayer-source",
        sourceProfileKey: "tcgplayer-pokemon-card",
        sourceProfileVersion: "2026.06.04",
        sourceMappingFingerprint: "sha256:tcgplayer-mapping",
        observedAt: "2026-06-09T01:00:00.000Z",
        addedAt: "2026-06-09T01:02:00.000Z",
      },
    ],
    promotion_intent: "create-catalog-item",
    created_at: "2026-06-09T01:02:00.000Z",
    updated_at: "2026-06-09T01:03:00.000Z",
    stale_at: null,
    observation_count: 2,
    ...overrides,
  };
}
