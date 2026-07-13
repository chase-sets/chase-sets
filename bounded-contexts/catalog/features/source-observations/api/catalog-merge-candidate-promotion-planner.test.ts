import { describe, expect, it } from "vitest";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type { CatalogMergeCandidateReviewSnapshot } from "../domain/catalog-merge-candidate";
import {
  planCatalogMergeCandidatePromotionCommands,
  type CatalogMergeCandidatePromotionCatalogMapping,
} from "./catalog-merge-candidate-promotion-planner";

describe("Catalog Merge Candidate promotion planner", () => {
  it("plans a previewable Catalog Item create with field provenance and separated external references", () => {
    const result = planCatalogMergeCandidatePromotionCommands({
      candidate: {
        candidateId: "cand_charizard",
        status: "ready",
        snapshot: candidateSnapshot(),
      },
      createCatalogItemId: "cat_charizard" as CatalogItemId,
      catalog: catalogMapping(),
      assetPlan: { imageUrls: ["https://images.example/cards/charizard.png"] },
    });

    expect(result.status).toBe("planned");
    expect(result.status === "planned" ? result.plan.commands.map((command) => command.type) : []).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "AssignCatalogItemToCategory",
      "SetCatalogItemImageUrls",
      "LinkExternalCatalogItemReference",
      "LinkExternalProductReference",
    ]);
    if (result.status !== "planned") {
      throw new Error("Expected planned result.");
    }

    expect(result.plan.promotableChange).toMatchObject({
      changeKind: "create-catalog-item",
      approvalStatus: "ready",
      candidateId: "cand_charizard",
      catalogItemId: "cat_charizard",
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
      externalProductReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "sku:900054",
          selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
        },
      ],
      referenceRecordLinks: [
        {
          fieldPath: "catalogItem.expansionName",
          fieldId: "field_expansion",
          referenceRecordId: "ref_expansion_pal",
        },
      ],
      productMappings: [
        {
          providerKey: "tcgplayer",
          externalKey: "sku:900054",
          selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
          matchedProductIds: [],
          reviewEvidence: { variantName: "Holofoil" },
        },
      ],
    });
    expect(result.plan.promotableChange.sourceProvenance).toMatchObject({
      identityFingerprint: "sha256:abc123",
      syncRunIds: ["job_sync_1"],
      membership: [expect.objectContaining({ observationId: "obs_tcgdex_054" })],
      fieldProvenance: expect.arrayContaining([expect.objectContaining({ fieldPath: "catalogItem.name" })]),
      warnings: [],
      conflicts: [],
      resolvedConflicts: [],
    });
    expect(result.plan.promotableChange.fieldChanges).toContainEqual(
      expect.objectContaining({
        fieldPath: "catalogItem.name",
        fieldId: "field_card_name",
        value: { defaultLocale: "en", values: { en: "Charizard ex" } },
        provenance: [
          expect.objectContaining({
            observationId: "obs_tcgdex_054",
            providerKey: "tcgdex",
          }),
        ],
      }),
    );
    expect(result.plan.commands).toContainEqual({
      type: "LinkExternalCatalogItemReference",
      providerKey: "tcgplayer",
      externalKey: "product:100054",
    });
    expect(result.plan.commands).toContainEqual({
      type: "LinkExternalProductReference",
      providerKey: "tcgplayer",
      externalKey: "sku:900054",
      selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
    });
  });

  it("plans approved update/reapply against the matched Catalog Item without creating a duplicate", () => {
    const snapshot = candidateSnapshot({
      matches: { catalogItemId: "cat_existing", productIds: ["prod_existing_holofoil"] },
      promotionIntent: "update-catalog-item",
    });
    const first = planCatalogMergeCandidatePromotionCommands({
      candidate: { candidateId: "cand_charizard", status: "promoted", snapshot },
      catalog: catalogMapping(),
      resolvedConflicts: [
        {
          conflictCode: "finish-provider-choice",
          fieldPath: "catalogItem.finish",
          chosenValue: "Holofoil",
          reason: "TCGplayer SKU carried the sellable finish.",
          observationIds: ["obs_tcgdex_054"],
        },
      ],
    });
    const reapplied = planCatalogMergeCandidatePromotionCommands({
      candidate: { candidateId: "cand_charizard", status: "promoted", snapshot },
      catalog: catalogMapping(),
      resolvedConflicts: [
        {
          conflictCode: "finish-provider-choice",
          fieldPath: "catalogItem.finish",
          chosenValue: "Holofoil",
          reason: "TCGplayer SKU carried the sellable finish.",
          observationIds: ["obs_tcgdex_054"],
        },
      ],
    });

    expect(first.status).toBe("planned");
    expect(reapplied.status).toBe("planned");
    if (first.status !== "planned" || reapplied.status !== "planned") {
      throw new Error("Expected planned results.");
    }

    expect(first.plan.catalogItemId).toBe("cat_existing");
    expect(first.plan.mode).toBe("refresh");
    expect(first.plan.commands.map((command) => command.type)).not.toContain("CreateCatalogItem");
    expect(first.plan.commands[0]).toMatchObject({ type: "ReviseCatalogItemMetadata" });
    expect(first.plan.promotableChange.approvalStatus).toBe("promoted");
    expect(first.plan.promotableChange.productMappings).toEqual([
      {
        providerKey: "tcgplayer",
        externalKey: "sku:900054",
        selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
        matchedProductIds: ["prod_existing_holofoil"],
        reviewEvidence: { variantName: "Holofoil" },
      },
    ]);
    expect(first.plan.promotableChange.sourceProvenance.resolvedConflicts).toEqual([
      expect.objectContaining({ conflictCode: "finish-provider-choice" }),
    ]);
    expect(reapplied.plan.planFingerprint).toBe(first.plan.planFingerprint);
    expect(reapplied.plan.commands).toEqual(first.plan.commands);
    expect(reapplied.plan.promotableChange).toEqual(first.plan.promotableChange);
  });

  it("blocks candidates with ambiguity or unresolved Product reference selection", () => {
    const result = planCatalogMergeCandidatePromotionCommands({
      candidate: {
        candidateId: "cand_blocked",
        status: "has-conflicts",
        snapshot: candidateSnapshot({
          conflicts: [
            {
              code: "rarity-mismatch",
              severity: "blocking",
              message: "Rarity differs between providers.",
              fieldPath: "catalogItem.rarity",
              observationIds: ["obs_tcgdex_054", "obs_tcgplayer_054"],
              existingValue: "Ultra Rare",
              proposedValue: "Double Rare",
            },
          ],
          proposedExternalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:900054",
              selectedOptions: [],
              reviewEvidence: null,
            },
          ],
        }),
      },
      createCatalogItemId: "cat_blocked" as CatalogItemId,
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "blocked",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "candidate-not-ready" }),
        expect.objectContaining({ code: "candidate-has-blocking-conflicts" }),
        expect.objectContaining({ code: "external-product-reference-missing-selected-options" }),
      ]),
    });
  });

  it("blocks when the same provider key is proposed at Catalog Item and Product reference levels", () => {
    const result = planCatalogMergeCandidatePromotionCommands({
      candidate: {
        candidateId: "cand_reference_conflict",
        status: "ready",
        snapshot: candidateSnapshot({
          proposedExternalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
          proposedExternalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "product:100054",
              selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
              reviewEvidence: null,
            },
          ],
        }),
      },
      createCatalogItemId: "cat_reference_conflict" as CatalogItemId,
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "blocked",
      diagnostics: [expect.objectContaining({ code: "conflicting-external-reference-level" })],
    });
  });

  it("blocks ambiguous duplicate external references before command planning", () => {
    const result = planCatalogMergeCandidatePromotionCommands({
      candidate: {
        candidateId: "cand_duplicate_refs",
        status: "ready",
        snapshot: candidateSnapshot({
          proposedExternalCatalogItemReferences: [
            { providerKey: "tcgplayer", externalKey: "product:100054" },
            { providerKey: "TCGPLAYER", externalKey: "product:100054" },
          ],
          proposedExternalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:900054",
              selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
              reviewEvidence: null,
            },
            {
              providerKey: "TCGPLAYER",
              externalKey: "sku:900054",
              selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_reverse_holofoil" }],
              reviewEvidence: null,
            },
          ],
        }),
      },
      createCatalogItemId: "cat_duplicate_refs" as CatalogItemId,
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "blocked",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-external-catalog-item-reference" }),
        expect.objectContaining({ code: "duplicate-external-product-reference" }),
      ]),
    });
  });

  it("blocks update planning when a ready candidate does not carry exactly one Catalog Item target", () => {
    const result = planCatalogMergeCandidatePromotionCommands({
      candidate: {
        candidateId: "cand_missing_target",
        status: "ready",
        snapshot: candidateSnapshot({
          matches: { catalogItemId: null, productIds: [] },
          promotionIntent: "update-catalog-item",
        }),
      },
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "blocked",
      diagnostics: [expect.objectContaining({ code: "missing-catalog-item-target" })],
    });
  });
});

function catalogMapping(): CatalogMergeCandidatePromotionCatalogMapping {
  return {
    blueprintId: "bp_pokemon_card" as BlueprintId,
    categoryId: "cat_pokemon" as CategoryId,
    fields: [
      {
        fieldPath: "catalogItem.name",
        fieldId: "field_card_name" as FieldId,
        valueKind: "localized-text",
        factKey: "name",
        required: true,
      },
      {
        fieldPath: "catalogItem.collectorNumber",
        fieldId: "field_card_number" as FieldId,
        valueKind: "raw",
        factKey: "collectorNumber",
        required: true,
      },
      {
        fieldPath: "catalogItem.expansionName",
        fieldId: "field_expansion" as FieldId,
        valueKind: "reference-record",
        referenceRecordId: "ref_expansion_pal" as ReferenceRecordId,
        required: true,
      },
      {
        fieldPath: "catalogItem.rarity",
        fieldId: "field_rarity" as FieldId,
        valueKind: "raw",
        factKey: "rarity",
      },
    ],
  };
}

function candidateSnapshot(
  overrides: Partial<CatalogMergeCandidateReviewSnapshot> = {},
): CatalogMergeCandidateReviewSnapshot {
  const proposedCatalogItemFacts: JsonObject = {
    name: "Charizard ex",
    collectorNumber: "054/091",
    expansionName: "Paldea Evolved",
    rarity: "Double Rare",
  };

  return {
    identityFingerprint: "sha256:abc123",
    syncRunIds: ["job_sync_1"],
    identity: {
      scopeRecordId: "scope_paldea_evolved",
      collectorNumber: "054/091",
      languageCode: "en",
      productForm: "pokemon-card",
      variantKey: "standard",
      barcode: null,
    },
    membership: [
      {
        observationId: "obs_tcgdex_054",
        syncRunId: "job_sync_1",
        providerKey: "tcgdex",
        externalKey: "sv2-054",
        sourceRecordHash: "hash_tcgdex",
        sourceProfileKey: "tcgdex-pokemon",
        sourceProfileVersion: "2026.06.24",
        sourceMappingFingerprint: "map_tcgdex",
        observedAt: "2026-06-24T11:59:00.000Z",
        addedAt: "2026-06-24T12:00:00.000Z",
      },
    ],
    matches: { catalogItemId: null, productIds: [] },
    proposedCatalogItemFacts,
    proposedExternalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
    proposedExternalProductReferences: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:900054",
        selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
        reviewEvidence: { variantName: "Holofoil" },
      },
    ],
    conflicts: [],
    warnings: [],
    fieldProvenance: [
      {
        fieldPath: "catalogItem.name",
        value: "Charizard ex",
        observationId: "obs_tcgdex_054",
        providerKey: "tcgdex",
        sourceProfileKey: "tcgdex-pokemon",
        sourceProfileVersion: "2026.06.24",
        confidence: "exact",
        evidence: { sourceField: "name", sourceMappingFingerprint: "map_tcgdex" },
      },
      {
        fieldPath: "catalogItem.collectorNumber",
        value: "054/091",
        observationId: "obs_tcgdex_054",
        providerKey: "tcgdex",
        sourceProfileKey: "tcgdex-pokemon",
        sourceProfileVersion: "2026.06.24",
        confidence: "exact",
        evidence: { sourceField: "collectorNumber", sourceMappingFingerprint: "map_tcgdex" },
      },
    ],
    promotionIntent: "create-catalog-item",
    ...overrides,
  };
}
