import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import { describe, expect, it } from "vitest";
import type { CatalogProviderSourceObservationInput } from "./provider-source-observation-normalizer";
import { assessCatalogProviderMappingMigration } from "./provider-mapping-migration-guard";

describe("provider mapping migration guard", () => {
  it("treats identical replay evidence as compatible", () => {
    const previous = observation();
    const next = observation();

    expect(
      assessCatalogProviderMappingMigration({
        previous,
        next,
        previousPromotionPlanFingerprint: "plan_1",
        nextPromotionPlanFingerprint: "plan_1",
      }),
    ).toEqual({ status: "compatible", diagnostics: [] });
  });

  it("detects external key, hash, selected-option, reference target, and promotion plan changes", () => {
    const result = assessCatalogProviderMappingMigration({
      previous: observation(),
      next: observation({
        externalKey: "base1-4:reverse-holo",
        sourceRecordHash: "hash_2",
        normalized: {
          ...normalized(),
          externalCatalogItemReferences: [],
          externalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "product:123",
              selectedOptions: [{ dimensionId: "finish", optionId: "reverse_holo" }],
            },
          ],
        },
      }),
      previousPromotionPlanFingerprint: "plan_1",
      nextPromotionPlanFingerprint: "plan_2",
    });

    expect(result.status).toBe("breaking-change");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "external-key-change",
      "source-hash-change",
      "selected-option-change",
      "reference-target-level-change",
      "promotion-plan-change",
    ]);
  });
});

function observation(
  overrides: Partial<CatalogProviderSourceObservationInput> = {},
): CatalogProviderSourceObservationInput {
  return {
    observationId: "tcgdex_en_base1_4",
    providerKey: "tcgdex",
    externalKey: "base1-4",
    sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-4",
    languageCode: "en",
    sourceRecordHash: "hash_1",
    sourceUpdatedAt: null,
    observedAt: "2026-06-03T00:00:00.000Z",
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    sourceMappingFingerprint: "mapping_1",
    normalized: normalized(),
    sourcePayload: { id: "base1-4" },
    ...overrides,
  };
}

function normalized(): CatalogProviderSourceObservationInput["normalized"] {
  return normalizedObservation();
}
