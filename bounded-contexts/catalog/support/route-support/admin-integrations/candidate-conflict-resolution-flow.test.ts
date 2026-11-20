import { describe, expect, it } from "vitest";
import { handleCandidateCommand } from "./candidate-command-handler";
import type { CatalogMergeCandidateConflictResolution } from "../../../features/source-observations/domain/catalog-merge-candidate";
import type { SourceObservationListRow } from "../../../features/source-observations/read-model/queries";
import type { CatalogItemId, FieldId, BlueprintId, CategoryId } from "../../../ids";
import { buildCatalogMergeCandidatesFromObservations } from "../../../features/source-observations/api/promotion/catalog-merge-candidate-matcher";
import { planCatalogMergeCandidatePromotionCommands } from "../../../features/source-observations/api/promotion/catalog-merge-candidate-promotion-planner";
import { createSyntheticDisplayIdentityQueryable } from "../../../features/source-observations/api/seeding/synthetic-display-identity-queryable";

describe("Catalog Merge Candidate conflict resolution form to plan", () => {
  it.each([
    { choice: "existing", rarities: ["Double Rare", "Ultra Rare"], expected: "Ultra Rare" },
    { choice: "proposed", rarities: ["Double Rare", "Ultra Rare"], expected: "Double Rare" },
    { choice: "existing", rarities: ["Double Rare", "Ultra Rare", "Rare"], expected: null },
  ])(
    "carries matcher alternatives through the $choice form choice into a scalar plan ($rarities)",
    async ({ choice, rarities, expected }) => {
      const candidate = matchedCandidate(rarities);
      const original = structuredClone(candidate.snapshot);
      const conflict = candidate.snapshot.conflicts.find((entry) => entry.code === "rarity-mismatch")!;
      expect(conflict.existingValue).toEqual(rarities.slice(1));
      const formData = new FormData();
      formData.set("candidateId", candidate.candidateId);
      formData.set("candidateVersion", "1");
      formData.set("reason", "Use the reviewed rarity.");
      formData.set(
        "blockingConflictsJson",
        JSON.stringify([
          {
            ...conflict,
            existingValueJson: JSON.stringify(conflict.existingValue),
            proposedValueJson: JSON.stringify(conflict.proposedValue),
          },
        ]),
      );
      formData.set(`resolution.${conflict.code}`, choice);
      formData.set(`reason.${conflict.code}`, "Use the reviewed rarity.");
      let resolutions: readonly CatalogMergeCandidateConflictResolution[] = [];
      const response = await handleCandidateCommand({
        api: {
          promoteCatalogMergeCandidate: async (
            _id: string,
            request: { conflictResolutions?: readonly CatalogMergeCandidateConflictResolution[] },
          ) => {
            resolutions = request.conflictResolutions ?? [];
          },
        } as never,
        intent: "candidate.promote",
        context: {
          section: "import-to-promotion",
          providerKey: "tcgdex",
          unitKey: "tcgdex:pokemon:card:import",
          scope: undefined,
          importScope: "en:3:base:base1",
          profileVersion: "2026.06.04",
          sourceObservationFilters: {},
          selectedObservationIds: [],
          reviewOffset: null,
          reviewLimit: null,
          jobId: null,
          promotionPreviewId: null,
          returnPath: null,
        },
        formData,
        selectedObservationIds: [],
      });
      expect(response.feedback.status).toBe("success");
      expect(resolutions[0]?.chosenValue).toEqual(choice === "existing" ? rarities.slice(1) : rarities[0]);
      const plan = (choices: readonly CatalogMergeCandidateConflictResolution[]) =>
        planCatalogMergeCandidatePromotionCommands({
          db: createSyntheticDisplayIdentityQueryable(),
          candidate: { ...candidate, status: "promoted" },
          createCatalogItemId: "cat_synthetic" as CatalogItemId,
          catalog: {
            blueprintId: "bp_synthetic" as BlueprintId,
            categoryId: "category_synthetic" as CategoryId,
            fields: [
              {
                fieldPath: "catalogItem.rarity",
                fieldId: "field_rarity" as FieldId,
                valueKind: "raw",
                factKey: "rarity",
              },
            ],
          },
          resolvedConflicts: choices,
        });
      const result = await plan(resolutions);
      if (expected === null) {
        expect(result).toMatchObject({
          status: "blocked",
          plan: null,
          diagnostics: [{ code: "ambiguous-conflict-resolution", path: "catalogItem.rarity" }],
        });
        const explicit = await plan([{ ...resolutions[0]!, chosenValue: "Rare" }]);
        expect(explicit.status).toBe("planned");
        expect(explicit.plan?.commands).toContainEqual({
          type: "SetCatalogItemFieldValue",
          fieldId: "field_rarity",
          value: "Rare",
        });
      } else {
        expect(result.status).toBe("planned");
        expect(result.plan?.commands).toContainEqual({
          type: "SetCatalogItemFieldValue",
          fieldId: "field_rarity",
          value: expected,
        });
        expect(result.plan?.promotableChange.catalogItemFacts.rarity).toBe(expected);
        expect(result.plan?.promotableChange.sourceProvenance.resolvedConflicts[0]?.chosenValue).toBe(expected);
        expect(result.plan?.promotableChange.sourceProvenance.fieldProvenance).toContainEqual(
          expect.objectContaining({ fieldPath: "catalogItem.rarity", value: expected, confidence: "manual" }),
        );
      }
      expect(candidate.snapshot).toEqual(original);
    },
  );
});

function matchedCandidate(rarities: readonly string[]) {
  const observations: SourceObservationListRow[] = rarities.map((rarity, index) => ({
    observation_id: `obs_${index}`,
    sync_run_id: null,
    provider_key: "tcgdex",
    external_key: `synthetic_${index}`,
    source_url: "https://provider.example/synthetic",
    language_code: "en",
    source_record_hash: `synthetic_${index}`,
    source_updated_at: null,
    observed_at: "2026-01-01T00:00:00Z",
    source_profile_key: "synthetic",
    source_profile_version: "1",
    source_mapping_fingerprint: "synthetic",
    normalized: {
      kind: "pokemon-card",
      tcg: "pokemon",
      languageCode: "en",
      name: "Synthetic card",
      cardNumber: "1",
      setId: "swsh3",
      setName: "Darkness Ablaze",
      expansionId: "swsh3",
      expansionName: "Darkness Ablaze",
      expansionAbbreviation: "DAA",
      expansionCardCount: 189,
      expansionParallelSetCardCount: null,
      seriesId: "swsh",
      seriesName: "Sword & Shield",
      rarity,
      illustrator: null,
      releaseDate: null,
      releaseYear: null,
      category: "Pokemon",
      imageBaseUrl: null,
      imageUrls: [],
      productAssetSet: null,
      parallelSet: false,
      cardVariantKey: "standard-set",
      cardVariantLabel: "Standard Set",
      cardVariantSourceKey: "normal",
      cardVariantIsPrimaryImage: true,
      imageDisclaimer: null,
      variants: {},
      externalCatalogItemReferences: [],
      externalProductReferences: [],
    },
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: "2026-01-01T00:00:00Z",
  }));
  const batch = buildCatalogMergeCandidatesFromObservations(observations, {
    addedAt: "2026-01-01T00:00:00Z",
    providerUnitKeyByObservationId: Object.fromEntries(
      observations.map((row) => [row.observation_id, "cards:pokemon:single"]),
    ),
    acceptedScopeMappings: [
      {
        mapping_id: "map_synthetic",
        scope_record_id: "scope_synthetic",
        provider_key: "tcgdex",
        unit_key: "cards:pokemon:single",
        product_line_id: null,
        series_id: null,
        set_id: "swsh3",
        set_name: "Darkness Ablaze",
        language_coordinates: { languageCode: "en" },
        confidence: "exact",
        review_status: "accepted",
        provenance: {},
        evidence: {},
        last_actor: "usr_synthetic",
        last_reason: "Synthetic fixture",
        policy_version: "scope-mapping-v1",
        proposed_at: "2026-01-01T00:00:00Z",
        reviewed_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  expect(batch.exclusions).toEqual([]);
  expect(batch.candidates).toHaveLength(1);
  return batch.candidates[0]!;
}
