import { normalizedObservation } from "../../../../support/test-support/source-observation-fixtures";
import { describe, expect, it } from "vitest";
import type { SourceObservationNormalized } from "../../domain/domain";
import type { SourceObservationListRow } from "../../read-model/queries";
import type { ProviderScopeMappingRow } from "../../../provider-scope-mapping/read-model/queries";
import { buildCatalogMergeCandidatesFromObservations } from "./catalog-merge-candidate-matcher";
import { TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "../provider-adapters/tcgplayer";

describe("Catalog Merge Candidate matcher", () => {
  it("merges aligned provider observations into one ready candidate with provenance", () => {
    const candidates = match([
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
    ]).candidates;

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.snapshot).toMatchObject({
      syncRunIds: ["job_sync_1"],
      membership: [
        { observationId: "obs_tcgdex_054", syncRunId: "job_sync_1" },
        { observationId: "obs_tcgplayer_054", syncRunId: "job_sync_1" },
      ],
      proposedCatalogItemFacts: {
        name: "Charizard ex",
        collectorNumber: "54",
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
    const candidates = match([
      observationRow("obs_tcgdex_054", "tcgdex", "sv2-054", {
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
        rarity: "Double Rare",
      }),
      observationRow("obs_tcgplayer_054", "tcgplayer", "product:100054", {
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
        rarity: "Ultra Rare",
      }),
    ]).candidates;

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
    const candidates = match([
      observationRow("obs_left", "tcgdex", "sv2-054", {
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
      }),
      observationRow("obs_right", "tcgplayer", "product:100054", {
        cardNumber: "55",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:100054" }],
      }),
    ]).candidates;

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.snapshot.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "merge-identity-mismatch" }),
        expect.objectContaining({ code: "repeated-external-catalog-item-reference" }),
      ]),
    );
  });

  it("keeps observations split when neither external references nor merge identity align", () => {
    const candidates = match([
      observationRow("obs_054", "tcgdex", "sv2-054"),
      observationRow("obs_055", "tcgdex", "sv2-055", { cardNumber: "55" }),
    ]).candidates;

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.snapshot.membership[0]?.observationId).sort()).toEqual([
      "obs_054",
      "obs_055",
    ]);
  });

  it("builds ready candidates from canonical TCGplayer Pokemon provider-product merge identity", () => {
    const candidates = match([
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
    ]).candidates;

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.snapshot).toMatchObject({
      identity: {
        scopeRecordId: "scope_base_set",
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

  it("groups Pokemon sealed observations by product form and barcode through an accepted scope mapping", () => {
    const observations = [
      pokemonSealedObservationRow("obs_pokemon_sealed_primary", "497105", "0820650851234"),
      pokemonSealedObservationRow("obs_pokemon_sealed_refresh", "497105-refresh", "0820650851234"),
      pokemonSealedObservationRow("obs_pokemon_sealed_alternate", "497105-alt", "0820650859999"),
    ];
    const result = buildCatalogMergeCandidatesFromObservations(observations, {
      addedAt: "2026-07-14T12:00:00.000Z",
      acceptedScopeMappings: [
        mappingRow({
          provider_key: "tcgplayer",
          unit_key: TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          scope_record_id: "scope_scarlet_violet",
          set_id: "10001",
          set_name: "Scarlet & Violet",
        }),
      ],
      providerUnitKeyByObservationId: Object.fromEntries(
        observations.map((observation) => [
          observation.observation_id,
          TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        ]),
      ),
    });

    expect(result.exclusions).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    const groupedCandidate = result.candidates.find((candidate) => candidate.snapshot.membership.length === 2);
    expect(groupedCandidate?.snapshot).toMatchObject({
      identity: {
        scopeRecordId: "scope_scarlet_violet",
        collectorNumber: "ETB",
        languageCode: "en",
        productForm: "sealed",
        barcode: "0820650851234",
      },
      membership: [{ observationId: "obs_pokemon_sealed_primary" }, { observationId: "obs_pokemon_sealed_refresh" }],
      proposedCatalogItemFacts: {
        name: "Scarlet & Violet Elite Trainer Box",
        setName: "Scarlet & Violet",
        productForm: "elite-trainer-box",
        barcode: "0820650851234",
      },
      conflicts: [],
      promotionIntent: "create-catalog-item",
    });
    expect(
      result.candidates.find((candidate) =>
        candidate.snapshot.membership.some((member) => member.observationId === "obs_pokemon_sealed_alternate"),
      )?.snapshot.identity.barcode,
    ).toBe("0820650859999");
  });

  it("merges different provider set names through accepted mappings to one canonical scope record", () => {
    const result = match(
      [
        observationRow("obs_tcgdex_paf", "tcgdex", "sv4pt5-001", {
          setId: "sv4pt5",
          setName: "Paldean Fates",
          expansionId: "sv4pt5",
          expansionName: "Paldean Fates",
          cardNumber: "1",
        }),
        observationRow("obs_tcgplayer_paf", "tcgplayer", "product:555001", {
          setId: "paf-marketplace",
          setName: "SV: Paldean Fates",
          expansionId: "paf-marketplace",
          expansionName: "SV: Paldean Fates",
          cardNumber: "1",
        }),
      ],
      [
        mappingRow({
          provider_key: "tcgdex",
          scope_record_id: "scope_paldean_fates",
          set_id: "sv4pt5",
          set_name: "Paldean Fates",
        }),
        mappingRow({
          provider_key: "tcgplayer",
          scope_record_id: "scope_paldean_fates",
          set_id: "paf-marketplace",
          set_name: "SV: Paldean Fates",
        }),
      ],
    );

    expect(result.exclusions).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.snapshot.identity).toMatchObject({
      scopeRecordId: "scope_paldean_fates",
      collectorNumber: "1",
    });
    expect(result.candidates[0]?.snapshot.membership.map((member) => member.observationId)).toEqual([
      "obs_tcgdex_paf",
      "obs_tcgplayer_paf",
    ]);
  });

  it("excludes unmapped observations with a visible reason", () => {
    const result = match([observationRow("obs_unmapped", "tcgplayer", "product:unmapped")], []);

    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toEqual([
      {
        observationId: "obs_unmapped",
        providerKey: "tcgplayer",
        unitKey: "cards:pokemon:single",
        code: "unmapped-provider-scope",
        reason: "No accepted Provider Scope Mapping matches this Source Observation's provider scope coordinates.",
        matchingScopeRecordIds: [],
      },
    ]);
  });

  it("does not borrow an accepted scope mapping from another ingestion unit", () => {
    const result = match(
      [observationRow("obs_wrong_unit", "tcgdex", "sv2-054")],
      [mappingRow({ provider_key: "tcgdex", unit_key: "cards:pokemon:sealed" })],
    );

    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toEqual([
      expect.objectContaining({
        observationId: "obs_wrong_unit",
        unitKey: "cards:pokemon:single",
        code: "unmapped-provider-scope",
      }),
    ]);
  });

  it("joins TCGdex languages through a language-neutral expansion mapping while preserving merge identity", () => {
    const english = observationRow("obs_tcgdex_en", "tcgdex", "sv2-en-054");
    const traditionalChinese = observationRow("obs_tcgdex_zh_tw", "tcgdex", "sv2-zh-tw-054", {
      languageCode: "zh-tw",
      setName: "帕底亞進化",
      expansionName: "帕底亞進化",
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "寶可夢集換式卡牌遊戲",
        setName: "帕底亞進化",
        printedProductName: "噴火龍ex",
        collectorNumber: "54",
        languageCode: "zh-tw",
        productForm: "pokemon-card",
      },
    });
    const languageNeutralMapping = mappingRow({
      provider_key: "tcgdex",
      set_id: "sv2",
      set_name: null,
      language_coordinates: {
        languageCode: null,
        providerLanguageCode: null,
        providerLanguageId: null,
        providerLocale: null,
        providerLanguageName: null,
      },
    });

    const candidate = match([english, traditionalChinese], [languageNeutralMapping]);
    const languageStampedMutant = match(
      [traditionalChinese],
      [mappingRow({ ...languageNeutralMapping, language_coordinates: { languageCode: "en" } })],
    );
    const combinedExpansionMutant = match(
      [traditionalChinese],
      [mappingRow({ ...languageNeutralMapping, set_name: "Paldea Evolved" })],
    );

    expect(candidate.exclusions).toEqual([]);
    expect(candidate.candidates).toHaveLength(2);
    expect(candidate.candidates.map((entry) => entry.snapshot.identity.languageCode).sort()).toEqual(["en", "zh-tw"]);
    expect(languageStampedMutant.candidates).toEqual([]);
    expect(languageStampedMutant.exclusions).toEqual([
      expect.objectContaining({ observationId: "obs_tcgdex_zh_tw", code: "unmapped-provider-scope" }),
    ]);
    expect(combinedExpansionMutant.candidates).toEqual([]);
    expect(combinedExpansionMutant.exclusions).toEqual([
      expect.objectContaining({ observationId: "obs_tcgdex_zh_tw", code: "unmapped-provider-scope" }),
    ]);
  });

  it("is deterministic and idempotent across observation and mapping order", () => {
    const observations = [
      observationRow("obs_tcgdex_054", "tcgdex", "sv2-054"),
      observationRow("obs_tcgplayer_054", "tcgplayer", "product:100054"),
    ];
    const mappings = defaultMappings();

    const first = match(observations, mappings);
    const second = match([...observations].reverse(), [...mappings].reverse());

    expect(second).toEqual(first);
  });
});

function match(
  observations: readonly SourceObservationListRow[],
  acceptedScopeMappings: readonly ProviderScopeMappingRow[] = defaultMappings(),
) {
  return buildCatalogMergeCandidatesFromObservations(observations, {
    addedAt: "2026-06-24T12:00:00.000Z",
    acceptedScopeMappings,
    providerUnitKeyByObservationId: Object.fromEntries(
      observations.map((observation) => [observation.observation_id, "cards:pokemon:single"]),
    ),
  });
}

function defaultMappings(): readonly ProviderScopeMappingRow[] {
  return [
    mappingRow({ provider_key: "tcgdex", set_id: "sv2", set_name: "Paldea Evolved" }),
    mappingRow({ provider_key: "tcgplayer", set_id: "sv2", set_name: "Paldea Evolved" }),
    mappingRow({
      provider_key: "tcgplayer",
      scope_record_id: "scope_base_set",
      set_id: null,
      set_name: "Base Set",
    }),
  ];
}

function mappingRow(overrides: Partial<ProviderScopeMappingRow>): ProviderScopeMappingRow {
  return {
    mapping_id: `map_${overrides.provider_key ?? "tcgdex"}_${overrides.scope_record_id ?? "scope_paldea_evolved"}`,
    scope_record_id: "scope_paldea_evolved",
    provider_key: "tcgdex",
    unit_key: "cards:pokemon:single",
    product_line_id: null,
    series_id: null,
    set_id: "sv2",
    set_name: "Paldea Evolved",
    language_coordinates: { languageCode: "en" },
    confidence: "exact",
    review_status: "accepted",
    provenance: {},
    evidence: {},
    last_actor: "usr_reviewer",
    last_reason: "verified",
    policy_version: "scope-mapping-v1",
    proposed_at: "2026-06-24T10:00:00.000Z",
    reviewed_at: "2026-06-24T10:05:00.000Z",
    updated_at: "2026-06-24T10:05:00.000Z",
    ...overrides,
  };
}

function observationRow(
  observationId: string,
  providerKey: string,
  externalKey: string,
  overrides: Partial<PokemonObservation> = {},
): SourceObservationListRow {
  const normalized = normalizedObservation({
    name: "Charizard ex",
    cardNumber: overrides.cardNumber ?? "54",
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
      collectorNumber: overrides.cardNumber ?? "54",
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
    language_code: normalized.languageCode,
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

function pokemonSealedObservationRow(
  observationId: string,
  externalKey: string,
  barcode: string,
): SourceObservationListRow {
  const normalized: Extract<SourceObservationNormalized, { kind: "pokemon-sealed-product" }> = {
    kind: "pokemon-sealed-product",
    tcg: "pokemon",
    languageCode: "en",
    name: "Scarlet & Violet Elite Trainer Box",
    setId: "10001",
    setCode: "svi",
    setName: "Scarlet & Violet",
    expansionName: "Scarlet & Violet",
    cardNumber: null,
    sealedProductForm: "elite-trainer-box",
    packCount: 9,
    releaseDate: "2023-03-31",
    releaseYear: 2023,
    productLineName: "Pokemon",
    barcode,
    imageUrls: ["https://images.example/pokemon/scarlet-violet-etb.jpg"],
    mergeIdentity: {
      tcg: "pokemon",
      productLineName: "Pokemon",
      setName: "Scarlet & Violet",
      printedProductName: "Scarlet & Violet Elite Trainer Box",
      collectorNumber: "ETB",
      languageCode: "en",
      productForm: "sealed",
      barcode,
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: `product:${externalKey}` }],
    externalProductReferences: [
      {
        providerKey: "tcgplayer",
        externalKey: `sku:${externalKey}`,
        selectedOptions: [{ dimensionId: "dim_product_form", optionId: "opt_unopened" }],
      },
    ],
  };

  return {
    observation_id: observationId,
    sync_run_id: "job_pokemon_sealed_sync",
    provider_key: "tcgplayer",
    external_key: externalKey,
    source_url: `https://www.tcgplayer.com/product/${externalKey}`,
    language_code: "en",
    source_record_hash: `${observationId}-hash`,
    source_updated_at: null,
    observed_at: "2026-07-14T11:59:00.000Z",
    source_profile_key: "pokemon-sealed-product-sku",
    source_profile_version: "2026.07.13",
    source_mapping_fingerprint: "tcgplayer-pokemon-sealed-mapping",
    normalized,
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: "2026-07-14T11:59:00.000Z",
  };
}
