import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import { describe, expect, it } from "vitest";
import type { SourceObservationNormalized } from "../domain/domain";
import type { SourceObservationListRow } from "../read-model/queries";
import { buildCatalogMergeCandidatesFromObservations } from "./catalog-merge-candidate-matcher";

describe("Catalog Merge Candidate matcher", () => {
  it("merges aligned provider observations into one ready candidate with provenance", () => {
    const candidates = buildCatalogMergeCandidatesFromObservations(
      [
        observationRow("obs_tcgdex_054", "tcgdex", "sv2-054", {
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
        }),
        observationRow("obs_tcgplayer_054", "tcgplayer", "product:100054", {
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
          externalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:900054",
              selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holofoil" }],
              reviewEvidence: { variantName: "Holofoil" },
            },
          ],
        }),
      ],
      { addedAt: "2026-06-24T12:00:00.000Z" },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.snapshot).toMatchObject({
      syncRunIds: ["job_sync_1"],
      membership: [
        { observationId: "obs_tcgdex_054", syncRunId: "job_sync_1" },
        { observationId: "obs_tcgplayer_054", syncRunId: "job_sync_1" },
      ],
      proposedCatalogItemFacts: {
        name: "Charizard ex",
        collectorNumber: "054/091",
      },
      proposedExternalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
      proposedExternalProductReferences: [{ providerKey: "tcgplayer", externalKey: "sku:900054" }],
      conflicts: [],
    });
    expect(candidates[0]?.snapshot.fieldProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "catalogItem.name",
          observationId: "obs_tcgdex_054",
        }),
      ]),
    );
  });

  it("projects blocking conflicts when matched observations disagree on proposed facts", () => {
    const candidates = buildCatalogMergeCandidatesFromObservations(
      [
        observationRow("obs_tcgdex_054", "tcgdex", "sv2-054", {
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
          rarity: "Double Rare",
        }),
        observationRow("obs_tcgplayer_054", "tcgplayer", "product:100054", {
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
          rarity: "Ultra Rare",
        }),
      ],
      { addedAt: "2026-06-24T12:00:00.000Z" },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.snapshot.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "rarity-mismatch",
          severity: "blocking",
          fieldPath: "catalogItem.rarity",
          observationIds: ["obs_tcgdex_054", "obs_tcgplayer_054"],
        }),
      ]),
    );
  });

  it("flags repeated marketplace IDs across materially different identities as ambiguous", () => {
    const candidates = buildCatalogMergeCandidatesFromObservations(
      [
        observationRow("obs_left", "tcgdex", "sv2-054", {
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
        }),
        observationRow("obs_right", "tcgplayer", "product:100054", {
          cardNumber: "055/091",
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
        }),
      ],
      { addedAt: "2026-06-24T12:00:00.000Z" },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.snapshot.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "merge-identity-mismatch" }),
        expect.objectContaining({ code: "repeated-external-catalog-item-reference" }),
      ]),
    );
  });

  it("keeps observations split when neither external references nor merge identity align", () => {
    const candidates = buildCatalogMergeCandidatesFromObservations(
      [
        observationRow("obs_054", "tcgdex", "sv2-054"),
        observationRow("obs_055", "tcgdex", "sv2-055", { cardNumber: "055/091" }),
      ],
      { addedAt: "2026-06-24T12:00:00.000Z" },
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.snapshot.membership[0]?.observationId).sort()).toEqual([
      "obs_054",
      "obs_055",
    ]);
  });

  it("builds ready candidates from canonical TCGplayer Pokemon provider-product merge identity", () => {
    const candidates = buildCatalogMergeCandidatesFromObservations(
      [
        providerProductObservationRow("tcgplayer_en_product_42346", "42346", {
          name: "Alakazam",
          cardNumber: "1",
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:42346" }],
          externalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:99942346",
              selectedOptions: [{ dimensionId: "printing", optionId: "normal" }],
            },
          ],
          skuReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:99942346",
              selectedOptions: [{ dimensionId: "printing", optionId: "normal" }],
            },
          ],
          mergeIdentity: {
            tcg: "pokemon",
            productLineName: "Pokemon",
            setName: "Base Set",
            printedProductName: "Alakazam",
            collectorNumber: "1",
            languageCode: "en",
            productForm: "single",
          },
        }),
      ],
      { addedAt: "2026-06-27T12:00:00.000Z" },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.snapshot).toMatchObject({
      identity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: "Base Set",
        printedProductName: "Alakazam",
        collectorNumber: "1",
        languageCode: "en",
        productForm: "single",
      },
      proposedCatalogItemFacts: {
        name: "Alakazam",
        setName: "Base Set",
        collectorNumber: "1",
        productLineName: "Pokemon",
        productForm: "single",
      },
      proposedExternalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:42346" }],
      proposedExternalProductReferences: [{ providerKey: "tcgplayer", externalKey: "sku:99942346" }],
      conflicts: [],
      promotionIntent: "create-catalog-item",
    });
  });
});

function observationRow(
  observationId: string,
  providerKey: string,
  externalKey: string,
  overrides: Partial<PokemonObservation> = {},
): SourceObservationListRow {
  const normalized = normalizedObservation({
    name: "Charizard ex",
    cardNumber: overrides.cardNumber ?? "054/091",
    setId: "sv2",
    setName: "Paldea Evolved",
    expansionId: "sv2",
    expansionName: "Paldea Evolved",
    expansionAbbreviation: "PAL",
    expansionCardCount: 193,
    expansionParallelSetCardCount: null,
    seriesId: "sv",
    seriesName: "Scarlet & Violet",
    rarity: "Double Rare",
    illustrator: null,
    releaseDate: "2023-06-09",
    releaseYear: 2023,
    imageBaseUrl: null,
    imageUrls: ["https://images.example/cards/sv2-054.png"],
    cardVariantKey: "standard",
    cardVariantLabel: "Standard",
    cardVariantSourceKey: "normal",
    cardVariantIsPrimaryImage: true,
    imageDisclaimer: null,
    variants: {},
    mergeIdentity: {
      tcg: "pokemon",
      productLineName: "Pokemon TCG",
      setName: "Paldea Evolved",
      printedProductName: "Charizard ex",
      collectorNumber: overrides.cardNumber ?? "054/091",
      languageCode: "en",
      productForm: "pokemon-card",
    },
    ...overrides,
  });

  return {
    observation_id: observationId,
    sync_run_id: "job_sync_1",
    provider_key: providerKey,
    external_key: externalKey,
    source_url: `https://provider.example/${externalKey}`,
    language_code: "en",
    source_record_hash: `${observationId}-hash`,
    source_updated_at: null,
    observed_at: "2026-06-24T11:59:00.000Z",
    source_profile_key: `${providerKey}-profile`,
    source_profile_version: "2026.06.24",
    source_mapping_fingerprint: `${providerKey}-mapping`,
    normalized,
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: "2026-06-24T11:59:00.000Z",
  };
}

type PokemonObservation = Extract<SourceObservationNormalized, { kind: "pokemon-card" }>;

function providerProductObservationRow(
  observationId: string,
  externalKey: string,
  overrides: Partial<ProviderProductObservation> = {},
): SourceObservationListRow {
  const normalized: ProviderProductObservation = {
    kind: "provider-product",
    languageCode: "en",
    name: "Alakazam",
    setName: "Base Set",
    expansionName: "Base Set",
    cardNumber: "1",
    imageUrls: [],
    providerProductId: externalKey,
    providerProductName: "Alakazam",
    productLineName: "Pokemon",
    productCategoryName: "Cards",
    productForm: "single",
    skuReferences: [],
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...overrides,
  };

  return {
    observation_id: observationId,
    sync_run_id: "job_sync_1",
    provider_key: "tcgplayer",
    external_key: externalKey,
    source_url: `https://provider.example/product/${externalKey}`,
    language_code: "en",
    source_record_hash: `${observationId}-hash`,
    source_updated_at: null,
    observed_at: "2026-06-27T11:59:00.000Z",
    source_profile_key: "pokemon-single-card-product-sku",
    source_profile_version: "2026.06.03",
    source_mapping_fingerprint: "tcgplayer-pokemon-mapping",
    normalized,
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: "2026-06-27T11:59:00.000Z",
  };
}

type ProviderProductObservation = Extract<SourceObservationNormalized, { kind: "provider-product" }>;
