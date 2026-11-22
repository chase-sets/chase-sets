import { describe, expect, it } from "vitest";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId, ReferenceRecordId } from "../../../../ids";
import type { CatalogMergeCandidateReviewSnapshot } from "../../domain/catalog-merge-candidate";
import { scrydexScryfallCardProviderProfile } from "../provider-integration-profiles";
import {
  planCatalogMergeCandidatePromotionCommands,
  type CatalogMergeCandidatePromotionCatalogMapping,
  type CatalogMergeCandidatePromotionPlanInput,
} from "./catalog-merge-candidate-promotion-planner";
import {
  createSyntheticDisplayIdentityQueryable,
  syntheticCurrentCatalogItem,
  type SyntheticDisplayIdentityFixture,
} from "../seeding/synthetic-display-identity-queryable";

// Every plan here runs the validated entry against SYNTHETIC display identity
// data: a resolving global title template plus a draft current item for the
// matched Catalog Item. Identity-degradation cases build their own fixtures.
function planPromotion(
  input: CatalogMergeCandidatePromotionPlanInput & Readonly<{ promoteAsDraft?: boolean }>,
  displayIdentity: SyntheticDisplayIdentityFixture = {},
) {
  return planCatalogMergeCandidatePromotionCommands({
    db: createSyntheticDisplayIdentityQueryable({
      currentItems: [syntheticCurrentCatalogItem({ catalog_item_id: "cat_existing" })],
      ...displayIdentity,
    }),
    ...input,
  });
}

describe("Catalog Merge Candidate promotion planner", () => {
  it.each(["create", "refresh", "operator-fallback", "link-existing"] as const)(
    "plans the fallback for a Magic merge candidate in %s",
    async (scenario) => {
      const catalog = {
        ...catalogMapping(),
        blueprintKey: scrydexScryfallCardProviderProfile.catalogFieldMapping.blueprintKey,
      };
      const create = scenario === "create";
      const target = syntheticCurrentCatalogItem({
        catalog_item_id: "cat_existing",
        image_fallback:
          scenario === "operator-fallback"
            ? { url: "/operator.png", alt: "Operator image", usage: "permanent", variants: {} }
            : null,
      });
      const result = await planPromotion(
        {
          candidate: {
            candidateId: "cand_magic",
            status: "ready",
            snapshot: create
              ? candidateSnapshot()
              : candidateSnapshot({
                  matches: { catalogItemId: target.catalog_item_id, productIds: [] },
                  promotionIntent: scenario === "link-existing" ? "link-existing-catalog-item" : "update-catalog-item",
                }),
          },
          catalog,
          createCatalogItemId: create ? ("cat_magic" as CatalogItemId) : null,
        },
        { currentItems: [target] },
      );

      expect(result.status).toBe("planned");
      const fallbacks = result.plan?.commands.filter((command) => command.type === "SetCatalogItemImageFallback");
      expect(fallbacks).toEqual(
        scenario === "create" || scenario === "refresh"
          ? [
              {
                type: "SetCatalogItemImageFallback",
                imageFallback: expect.objectContaining({
                  url: "/fake-cdn/assets/magic-card-back.svg",
                  usage: "permanent",
                }),
              },
            ]
          : [],
      );
    },
  );

  it("plans a previewable Catalog Item create with field provenance and separated external references", async () => {
    const result = await planPromotion({
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

  it("plans approved update/reapply against the matched Catalog Item without creating a duplicate", async () => {
    const snapshot = candidateSnapshot({
      matches: { catalogItemId: "cat_existing", productIds: ["prod_existing_holofoil"] },
      promotionIntent: "update-catalog-item",
    });
    const first = await planPromotion({
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
    const reapplied = await planPromotion({
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

  it("blocks candidates with ambiguity or unresolved Product reference selection", async () => {
    const result = await planPromotion({
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

  it.each([
    ["Ultra Rare", true],
    ["Double Rare", true],
    ["Ultra Rare", false],
  ] as const)(
    "writes the chosen conflict value %s, not the proposal (retained conflict: %s)",
    async (chosenValue, retainedConflict) => {
      const resolution = {
        conflictCode: "rarity-mismatch",
        fieldPath: "catalogItem.rarity",
        chosenValue,
        reason: "Use the reviewed rarity.",
        observationIds: ["obs_tcgdex_054"],
      };
      const result = await planPromotion({
        candidate: {
          candidateId: "cand_charizard",
          status: "promoted",
          snapshot: candidateSnapshot({
            matches: { catalogItemId: "cat_existing", productIds: [] },
            promotionIntent: "update-catalog-item",
            conflicts: retainedConflict
              ? [
                  {
                    code: resolution.conflictCode,
                    fieldPath: resolution.fieldPath,
                    severity: "blocking",
                    message: "Rarity differs.",
                    observationIds: resolution.observationIds,
                    existingValue: "Ultra Rare",
                    proposedValue: "Double Rare",
                  },
                ]
              : [],
            fieldProvenance: [
              {
                fieldPath: resolution.fieldPath,
                value: "Double Rare",
                observationId: "obs_tcgdex_054",
                providerKey: "tcgdex",
                sourceProfileKey: "tcgdex-pokemon",
                sourceProfileVersion: "2026.06.24",
                confidence: "exact",
                evidence: {},
              },
            ],
          }),
        },
        catalog: catalogMapping(),
        resolvedConflicts: [resolution],
      });

      expect(result.status).toBe("planned");
      if (result.status !== "planned") throw new Error("Expected a resolved promotion plan.");
      expect(result.plan.commands).toContainEqual({
        type: "SetCatalogItemFieldValue",
        fieldId: "field_rarity",
        value: chosenValue,
      });
      expect(result.plan.promotableChange.catalogItemFacts.rarity).toBe(chosenValue);
      expect(result.plan.promotableChange.sourceProvenance.resolvedConflicts).toEqual([resolution]);
      expect(result.plan.promotableChange.fieldChanges).toContainEqual(
        expect.objectContaining({
          fieldPath: resolution.fieldPath,
          value: chosenValue,
          provenance: [expect.objectContaining({ value: chosenValue, confidence: "manual" })],
        }),
      );
    },
  );

  it.each([null, 0, false, [null], [0], [false]].map((chosenValue) => ({ chosenValue })))(
    "preserves an explicit raw resolution of $chosenValue",
    async ({ chosenValue }) => {
      const result = await planPromotion({
        candidate: {
          candidateId: "cand_charizard",
          status: "promoted",
          snapshot: candidateSnapshot({
            matches: { catalogItemId: "cat_existing", productIds: [] },
            promotionIntent: "update-catalog-item",
          }),
        },
        catalog: catalogMapping(),
        resolvedConflicts: [
          {
            conflictCode: "rarity-mismatch",
            fieldPath: "catalogItem.rarity",
            chosenValue,
            reason: "Reviewed value.",
            observationIds: [],
          },
        ],
      });
      expect(result.status).toBe("planned");
      expect(result.plan?.commands).toContainEqual({
        type: "SetCatalogItemFieldValue",
        fieldId: "field_rarity",
        value: Array.isArray(chosenValue) ? chosenValue[0] : chosenValue,
      });
    },
  );

  it("applies multiple choices to localized metadata and mapped fields without mutating source evidence", async () => {
    const snapshot = candidateSnapshot();
    const original = structuredClone(snapshot);
    const result = await planPromotion({
      candidate: { candidateId: "cand_charizard", status: "ready", snapshot },
      createCatalogItemId: "cat_charizard" as CatalogItemId,
      catalog: catalogMapping(),
      resolvedConflicts: [
        {
          conflictCode: "name-mismatch",
          fieldPath: "catalogItem.name",
          chosenValue: "Kept name",
          reason: "Reviewed name.",
          observationIds: [],
        },
        {
          conflictCode: "rarity-mismatch",
          fieldPath: "catalogItem.rarity",
          chosenValue: "Ultra Rare",
          reason: "Reviewed rarity.",
          observationIds: [],
        },
      ],
    });
    expect(result.status).toBe("planned");
    expect(result.plan?.commands).toContainEqual(
      expect.objectContaining({
        type: "CreateCatalogItem",
        title: { defaultLocale: "en", values: { en: "Kept name" } },
      }),
    );
    expect(result.plan?.commands).toContainEqual({
      type: "SetCatalogItemFieldValue",
      fieldId: "field_card_name",
      value: { defaultLocale: "en", values: { en: "Kept name" } },
    });
    expect(result.plan?.commands).toContainEqual({
      type: "SetCatalogItemFieldValue",
      fieldId: "field_rarity",
      value: "Ultra Rare",
    });
    expect(result.plan?.promotableChange.sourceProvenance.fieldProvenance).toContainEqual(
      expect.objectContaining({ fieldPath: "catalogItem.rarity", value: "Ultra Rare", confidence: "manual" }),
    );
    expect(snapshot).toEqual(original);
  });

  it.each(["Paldea Evolved", "Previous expansion", ["Previous expansion"]].map((chosenValue) => ({ chosenValue })))(
    "honors the reference field choice $chosenValue",
    async ({ chosenValue }) => {
      const result = await planPromotion({
        candidate: {
          candidateId: "cand_charizard",
          status: "promoted",
          snapshot: candidateSnapshot({
            matches: { catalogItemId: "cat_existing", productIds: [] },
            promotionIntent: "update-catalog-item",
            conflicts: [
              {
                code: "expansionName-mismatch",
                fieldPath: "catalogItem.expansionName",
                severity: "blocking",
                message: "Expansion differs.",
                observationIds: [],
                existingValue: ["Previous expansion", "Another expansion"],
                proposedValue: "Paldea Evolved",
              },
            ],
          }),
        },
        catalog: catalogMapping(),
        resolvedConflicts: [
          {
            conflictCode: "expansionName-mismatch",
            fieldPath: "catalogItem.expansionName",
            chosenValue,
            reason: "Reviewed expansion.",
            observationIds: [],
          },
        ],
      });
      expect(result.status).toBe("planned");
      expect(
        result.plan?.commands.filter(
          (command) =>
            command.type === "SetCatalogItemFieldValue" && command.fieldId === ("field_expansion" as FieldId),
        ),
      ).toEqual(
        chosenValue !== "Paldea Evolved"
          ? []
          : [
              {
                type: "SetCatalogItemFieldValue",
                fieldId: "field_expansion",
                value: { referenceId: "ref_expansion_pal" },
              },
            ],
      );
      expect(result.plan?.promotableChange.referenceRecordLinks).toHaveLength(chosenValue !== "Paldea Evolved" ? 0 : 1);
    },
  );

  it("does not resolve a blocking conflict using a choice for another field", async () => {
    const result = await planPromotion({
      candidate: {
        candidateId: "cand_charizard",
        status: "promoted",
        snapshot: candidateSnapshot({
          conflicts: [
            {
              code: "rarity-mismatch",
              fieldPath: "catalogItem.rarity",
              severity: "blocking",
              message: "Rarity differs.",
              observationIds: [],
              existingValue: "Ultra Rare",
              proposedValue: "Double Rare",
            },
          ],
        }),
      },
      createCatalogItemId: "cat_charizard" as CatalogItemId,
      catalog: catalogMapping(),
      resolvedConflicts: [
        {
          conflictCode: "rarity-mismatch",
          fieldPath: "catalogItem.name",
          chosenValue: "Wrong field",
          reason: "Mismatched choice.",
          observationIds: [],
        },
      ],
    });
    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "candidate-has-blocking-conflicts", path: "catalogItem.rarity" }),
    );
  });

  it("blocks when the same provider key is proposed at Catalog Item and Product reference levels", async () => {
    const result = await planPromotion({
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

  it("blocks ambiguous duplicate external references before command planning", async () => {
    const result = await planPromotion({
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

  it("blocks update planning when a ready candidate does not carry exactly one Catalog Item target", async () => {
    const result = await planPromotion({
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

  describe("display identity validation before commands", () => {
    // Blueprint template needing the mapped expansion reference's code attribute.
    const template = {
      key: "pokemon-card-title",
      target_kind: "blueprint" as const,
      target_id: "bp_pokemon_card",
      priority: 10,
      title_template: "{field.card-name} {field.card-number} {reference.expansion.attributes.code}",
      subtitle_template: null,
      required_field_keys: ["card-name"],
    };
    const fields = [
      { field_id: "field_card_name", key: "card-name" },
      { field_id: "field_card_number", key: "card-number" },
      { field_id: "field_expansion", key: "expansion" },
    ];
    const expansion = (attributes: Readonly<Record<string, unknown>>) => ({
      reference_record_id: "ref_expansion_pal",
      type_key: "expansion",
      key: "sv02",
      name: "Paldea Evolved",
      attributes,
      relationships: [],
      status: "active",
    });
    const createCandidate = {
      candidate: { candidateId: "cand_charizard", status: "ready" as const, snapshot: candidateSnapshot() },
      createCatalogItemId: "cat_charizard" as CatalogItemId,
      catalog: catalogMapping(),
    };

    it("produces no publishable command and a deterministic diagnostic for a degraded proposed identity", async () => {
      const result = await planPromotion(createCandidate, {
        fields,
        templates: [template],
        referenceRecords: [expansion({})],
      });
      const again = await planPromotion(createCandidate, {
        fields,
        templates: [template],
        referenceRecords: [expansion({})],
      });

      expect(result).toEqual({
        status: "blocked",
        plan: null,
        diagnostics: [
          {
            code: "display-identity-unresolvable",
            path: "displayIdentity",
            diagnosticText: "Matched template has unresolved title tokens.",
            displayIdentity: {
              missingTokens: ["reference.expansion.attributes.code"],
              templateKey: "pokemon-card-title",
              templateTargetKind: "blueprint",
              templateTargetId: "bp_pokemon_card",
              templateReason: "unresolved-title-tokens",
            },
          },
        ],
      });
      expect(again).toEqual(result);
    });

    it("re-plans to a normal publishable path once the reference data is repaired, or as draft only by explicit choice", async () => {
      const degraded = { fields, templates: [template], referenceRecords: [expansion({})] };
      const repaired = { fields, templates: [template], referenceRecords: [expansion({ code: "PAL" })] };
      const blocked = await planPromotion(createCandidate, degraded);
      const draft = await planPromotion({ ...createCandidate, promoteAsDraft: true }, degraded);
      const afterRepair = await planPromotion(createCandidate, repaired);

      expect(blocked.status).toBe("blocked");
      expect(draft.status).toBe("planned");
      expect(draft.plan?.promoteAsDraft).toBe(true);
      expect(draft.diagnostics).toHaveLength(1);
      expect(afterRepair.status).toBe("planned");
      expect(afterRepair.diagnostics).toEqual([]);
      expect(afterRepair.plan?.displayIdentity).toMatchObject({ resolutionStatus: "resolved", missingTokens: [] });
      expect(afterRepair.plan?.planFingerprint).not.toBe(draft.plan?.planFingerprint);
    });

    it("validates link-existing against the unchanged current Catalog Item", async () => {
      const snapshot = candidateSnapshot({
        matches: { catalogItemId: "cat_existing", productIds: [] },
        promotionIntent: "link-existing-catalog-item",
      });
      const linkExisting = {
        candidate: { candidateId: "cand_link", status: "ready" as const, snapshot },
        catalog: catalogMapping(),
      };
      const resolvedCurrent = await planPromotion(linkExisting, {
        fields,
        templates: [template],
        referenceRecords: [expansion({ code: "PAL" })],
        currentItems: [
          syntheticCurrentCatalogItem({
            catalog_item_id: "cat_existing",
            blueprint_id: "bp_pokemon_card",
            field_values: [
              { fieldId: "field_card_name", value: "Current name" },
              { fieldId: "field_card_number", value: "54" },
              { fieldId: "field_expansion", value: { referenceId: "ref_expansion_pal" } },
            ],
          }),
        ],
      });
      // The proposal carries the same facts, but link-existing never overlays
      // them: the current item without the expansion field stays degraded.
      const degradedCurrent = await planPromotion(linkExisting, {
        fields,
        templates: [template],
        referenceRecords: [expansion({ code: "PAL" })],
        currentItems: [
          syntheticCurrentCatalogItem({
            catalog_item_id: "cat_existing",
            blueprint_id: "bp_pokemon_card",
            field_values: [{ fieldId: "field_card_name", value: "Current name" }],
          }),
        ],
      });

      expect(resolvedCurrent.status).toBe("planned");
      expect(resolvedCurrent.plan?.commands.map((command) => command.type)).not.toContain("SetCatalogItemFieldValue");
      expect(degradedCurrent.status).toBe("blocked");
      expect(degradedCurrent.diagnostics[0]).toMatchObject({
        code: "display-identity-unresolvable",
        displayIdentity: {
          missingTokens: ["field.card-number", "reference.expansion.attributes.code"],
          templateReason: "unresolved-title-tokens",
        },
      });
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
    collectorNumber: "54",
    expansionName: "Paldea Evolved",
    rarity: "Double Rare",
  };

  return {
    identityFingerprint: "sha256:abc123",
    syncRunIds: ["job_sync_1"],
    identity: {
      scopeRecordId: "scope_paldea_evolved",
      collectorNumber: "54",
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
        value: "54",
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
