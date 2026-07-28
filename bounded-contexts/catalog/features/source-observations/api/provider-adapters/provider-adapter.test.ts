import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  CatalogIntegrationUnitDescriptor,
  ProviderAdapter,
  ProviderImportPlan,
  ProviderPayloadEnvelope,
} from "./provider-adapter";
import {
  createReferenceCardsProviderAdapter,
  REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
  runReferenceCardsSourceObservationProofDryRun,
} from "./reference-cards";
import {
  createMtgjsonValidationProviderAdapter,
  MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
  MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  runMtgjsonSourceObservationValidationDryRun,
} from "./mtgjson";
import {
  createLorcanajsonProviderAdapter,
  createLorcanajsonValidationProviderAdapter,
  LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  runLorcanajsonCardReferenceValidationDryRun,
} from "./lorcanajson";
import {
  createLorcastValidationProviderAdapter,
  LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  runLorcastCardReferenceValidationDryRun,
} from "./lorcast";
import { ProviderAdapterRegistry } from "./registry";
import {
  createScryfallValidationProviderAdapter,
  runScryfallSourceObservationValidationDryRun,
  SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./scryfall";
import {
  createTcgdexProviderAdapter,
  runTcgdexSourceObservationImportProofDryRun,
  TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./tcgdex";
import {
  runTcgplayerLorcanaSealedProductSourceObservationImportProofDryRun,
  runTcgplayerLorcanaSingleCardSourceObservationImportProofDryRun,
  createTcgplayerProviderAdapter,
  runTcgplayerMtgSealedProductSourceObservationImportProofDryRun,
  runTcgplayerMtgSingleCardSourceObservationImportProofDryRun,
  runTcgplayerOnePieceSealedProductSourceObservationImportProofDryRun,
  TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./tcgplayer";
import {
  type CatalogProviderIntegrationProfileVersionRecord,
  getActiveCatalogProviderIntegrationProfileVersion,
  getCatalogProviderIntegrationProfileVersion,
} from "../provider-integration-profiles";
import { tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract } from "../tcgplayer-executable-mapping-contract";
import type {
  TcgplayerAutomationCatalogClient,
  TcgplayerAutomationProductDetail,
} from "../providers/tcgplayer-automation-catalog-client";
import { tcgplayerAutomationResponseFixtures } from "../providers/tcgplayer-automation-response-fixtures.test-data";

type ReferenceCardPayload = Readonly<{
  providerCardId: string;
  name: string;
}>;

const referencePokemonUnit: CatalogIntegrationUnitDescriptor = {
  unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
  providerKey: "reference-cards",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-proof",
  displayName: "Reference Pokemon single-card Source Observation proof",
};

const referenceMtgUnit: CatalogIntegrationUnitDescriptor = {
  unitKey: "reference-cards:mtg:single-card:source-observation-proof",
  providerKey: "reference-cards",
  productDomain: "mtg",
  productForm: "single-card",
  ingestionPurpose: "source-observation-proof",
  displayName: "Reference MTG single-card Source Observation proof",
};

describe("ProviderAdapterRegistry", () => {
  it("resolves provider adapters by provider key without switch branches", () => {
    const registry = new ProviderAdapterRegistry([referenceCardsAdapter()]);

    expect(registry.require("REFERENCE-CARDS").providerKey).toBe("reference-cards");
    expect(registry.listProviderKeys()).toEqual(["reference-cards"]);
  });

  it("rejects duplicate provider adapter registrations", () => {
    expect(() => new ProviderAdapterRegistry([referenceCardsAdapter(), referenceCardsAdapter()])).toThrow(
      "Duplicate provider adapter registered for 'reference-cards'.",
    );
  });

  it("supports one adapter serving multiple ingestion units with typed payload provenance", async () => {
    const adapter = referenceCardsAdapter();
    const units = await adapter.listIntegrationUnits();
    const plan = await adapter.planImport({
      unitKey: referencePokemonUnit.unitKey,
      scopeKey: "fixture-card",
      values: { fixture: "abra-43" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));

    expect(units.map((unit) => unit.unitKey)).toEqual([referencePokemonUnit.unitKey, referenceMtgUnit.unitKey]);
    expect(plan.transportSteps).toEqual(["load-fixture-payload"]);
    expect(payloads).toEqual([
      {
        unitKey: referencePokemonUnit.unitKey,
        providerKey: "reference-cards",
        externalKey: "abra-43",
        payload: {
          providerCardId: "abra-43",
          name: "Abra 43/102",
        },
        provenance: {
          fetchedAt: "2026-06-05T00:00:00.000Z",
          sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
          contentHash: "reference-hash-abra-43",
        },
      },
    ]);
  });

  it("keeps transport diagnostics separate from Catalog promotion and replay semantics", async () => {
    const diagnostics = await referenceCardsAdapter().getTransportDiagnostics();

    expect(diagnostics).toEqual([
      {
        code: "reference-fixtures-ready",
        severity: "info",
        message: "Reference fixture payloads are available.",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/promotion|replay|duplicate-prevention/i);
  });

  it("keeps fixture-backed credential readiness explicit and secret-free", async () => {
    const readiness = await referenceCardsAdapter().getCredentialReadiness();

    expect(readiness).toEqual([
      expect.objectContaining({
        providerKey: "reference-cards",
        requirement: "not-required",
        sourceKind: "none",
        state: "not-required",
        importBlocking: false,
      }),
    ]);
    expect(JSON.stringify(readiness)).not.toMatch(/token|cookie|secret|password/i);
  });

  it("ships a fixture-backed reference adapter that proves the selected first slice", async () => {
    const adapter = createReferenceCardsProviderAdapter();
    const units = await adapter.listIntegrationUnits();
    const dryRun = await runReferenceCardsSourceObservationProofDryRun(adapter);

    expect(units.map((unit) => unit.unitKey)).toEqual([
      REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
    ]);
    expect(dryRun).toMatchObject({
      unitKey: REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
      profileVersion: "reference-proof-2026.06.05",
      observations: [
        {
          providerKey: "reference-cards",
          externalKey: "pokemon:abra-43",
          normalizedFacts: {
            name: "Abra",
            cardNumber: "43",
            expansionName: "Reference Proof",
            rarity: "Common",
          },
        },
      ],
      diagnostics: [],
    });
  });

  it("serves TCGdex option transport through the ProviderAdapter boundary", async () => {
    const adapter = createTcgdexProviderAdapter({
      loadActiveProfileVersion: async () => requireTcgdexProfileVersion(),
      fetch: tcgdexFetch({
        "https://api.tcgdex.net/v2/en/series": [
          { id: "me", name: "Mega Evolution", logo: "https://assets.tcgdex.net/en/me/logo" },
        ],
        "https://api.tcgdex.net/v2/en/series/me": {
          id: "me",
          name: "Mega Evolution",
          sets: [
            {
              id: "me02.5",
              name: "Ascended Heroes",
              logo: "https://assets.tcgdex.net/en/me/me02.5/logo",
              symbol: "https://assets.tcgdex.net/univ/me/me02.5/symbol",
              cardCount: { total: 295, official: 217 },
            },
          ],
        },
      }),
    });

    await expect(adapter.listIntegrationUnits()).resolves.toEqual([
      {
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "tcgdex",
        productDomain: "pokemon",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
        displayName: "TCGdex Pokemon single-card Source Observation import",
        profileVersion: "2026.06.03",
      },
    ]);
    await expect(
      adapter.listOptions({
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "languages",
      }),
    ).resolves.toMatchObject({ items: expect.arrayContaining([{ value: "en", label: "en" }]) });
    await expect(
      adapter.listOptions({
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "series",
        parentValues: { languageCode: "en" },
      }),
    ).resolves.toEqual({
      items: [{ value: "me", label: "Mega Evolution", metadata: { logoUrl: "https://assets.tcgdex.net/en/me/logo" } }],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "expansions",
        parentValues: { languageCode: "en", seriesId: "me" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "me02.5",
          label: "Ascended Heroes",
          parentValue: "me",
          metadata: {
            seriesName: "Mega Evolution",
            logoUrl: "https://assets.tcgdex.net/en/me/me02.5/logo",
            symbolUrl: "https://assets.tcgdex.net/univ/me/me02.5/symbol",
            cardCount: "295",
            officialCardCount: "217",
          },
        },
      ],
    });
  });

  it("attaches typed English option aliases from the same-id English endpoint to non-English TCGdex options", async () => {
    const adapter = createTcgdexProviderAdapter({
      loadActiveProfileVersion: async () => requireTcgdexProfileVersion(),
      fetch: tcgdexFetch({
        "https://api.tcgdex.net/v2/ja/series": [{ id: "SV", name: "ポケモンカードゲーム スカーレット&バイオレット" }],
        "https://api.tcgdex.net/v2/en/series/SV": { id: "SV", name: "Scarlet & Violet" },
        "https://api.tcgdex.net/v2/ja/series/sv": {
          id: "SV",
          name: "ポケモンカードゲーム スカーレット&バイオレット",
          sets: [{ id: "SV8", name: "超電ブレイカー", cardCount: { total: 106, official: 106 } }],
        },
        "https://api.tcgdex.net/v2/en/sets/SV8": { id: "SV8", name: "Surging Sparks" },
      }),
    });

    await expect(
      adapter.listOptions({
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "series",
        parentValues: { languageCode: "ja" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "SV",
          label: "ポケモンカードゲーム スカーレット&バイオレット",
          aliases: [
            expect.objectContaining({
              aliasText: "Scarlet & Violet",
              aliasLanguageCode: "en",
              aliasType: "series-equivalent",
              confidence: "high",
              reviewStatus: "pending",
              sourceCategory: "provider-same-id-localized-endpoint",
            }),
          ],
        },
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "expansions",
        parentValues: { languageCode: "ja", seriesId: "SV" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "SV8",
          label: "超電ブレイカー",
          parentValue: "SV",
          aliases: [
            expect.objectContaining({
              aliasText: "Surging Sparks",
              aliasLanguageCode: "en",
              aliasType: "set-equivalent",
              confidence: "high",
              reviewStatus: "pending",
              sourceCategory: "provider-same-id-localized-endpoint",
            }),
          ],
          metadata: {
            cardCount: "106",
            officialCardCount: "106",
            seriesName: "ポケモンカードゲーム スカーレット&バイオレット",
          },
        },
      ],
    });
  });

  it("emits no option alias for English selections and for non-English options without an English mirror", async () => {
    const adapter = createTcgdexProviderAdapter({
      loadActiveProfileVersion: async () => requireTcgdexProfileVersion(),
      fetch: tcgdexFetch({
        "https://api.tcgdex.net/v2/en/series": [{ id: "sv", name: "Scarlet & Violet" }],
        "https://api.tcgdex.net/v2/ja/series": [{ id: "JP-ONLY", name: "日本限定シリーズ" }],
        // No https://api.tcgdex.net/v2/en/series/JP-ONLY mirror exists (404).
      }),
    });

    // English selections have no localized name to translate: no alias attached.
    await expect(
      adapter.listOptions({
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "series",
        parentValues: { languageCode: "en" },
      }),
    ).resolves.toEqual({
      items: [{ value: "sv", label: "Scarlet & Violet" }],
    });

    // Non-English option with no English mirror falls back safely to the native
    // name with no alias, rather than guessing an English equivalent.
    await expect(
      adapter.listOptions({
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "series",
        parentValues: { languageCode: "ja" },
      }),
    ).resolves.toEqual({
      items: [{ value: "JP-ONLY", label: "日本限定シリーズ" }],
    });
  });

  it("plans and fetches TCGdex import payloads with typed provenance", async () => {
    const progress: unknown[] = [];
    const adapter = createTcgdexProviderAdapter({
      loadActiveProfileVersion: async () => requireTcgdexProfileVersion(),
      fetch: tcgdexFetch({
        "https://api.tcgdex.net/v2/en/sets/swsh3": {
          id: "swsh3",
          name: "Darkness Ablaze",
          cards: [{ id: "swsh3-136", localId: "136", name: "Furret" }],
        },
        "https://api.tcgdex.net/v2/en/cards/swsh3-136": {
          id: "swsh3-136",
          localId: "136",
          name: "Furret",
          category: "Pokemon",
          set: { id: "swsh3", name: "Darkness Ablaze" },
        },
      }),
    });
    const plan = await adapter.planImport({
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { languageCode: "en", setId: "swsh3" },
    });
    const payloads = await collectPayloads(
      adapter.fetchPayloads(plan, {
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(plan).toMatchObject({
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      planKey: "tcgdex:en:swsh3",
      transportSteps: ["Fetch TCGdex expansion metadata", "Fetch TCGdex card payloads", "Attach payload provenance"],
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      providerKey: "tcgdex",
      externalKey: "swsh3-136",
      provenance: {
        sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
      },
      payload: {
        payload: {
          externalKey: "swsh3-136",
        },
      },
    });
    expect(progress).toEqual([
      { phase: "fetching", completed: 0, total: 1, currentLabel: null },
      { phase: "fetching", completed: 1, total: 1, currentLabel: "Furret" },
    ]);
  });

  it("keeps TCGdex adapter diagnostics transport-only", async () => {
    const diagnostics = await createTcgdexProviderAdapter({
      loadActiveProfileVersion: async () => requireTcgdexProfileVersion(),
    }).getTransportDiagnostics();

    expect(diagnostics).toEqual([
      {
        code: "tcgdex-json-transport-configured",
        severity: "info",
        message: "TCGdex JSON transport is configured for tcgdex-json.",
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/promotion|replay|duplicate-prevention/i);
  });

  it("proves the TCGdex real-provider ingestion unit through adapter fetch and engine dry-run", async () => {
    const dryRun = await runTcgdexSourceObservationImportProofDryRun();

    expect(dryRun).toMatchObject({
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      profileVersion: "2026.06.03",
      observations: [
        {
          providerKey: "tcgdex",
          externalKey: "swsh3-136",
          sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
          sourceUpdatedAt: "2026-05-15T00:00:00.000Z",
          normalizedFacts: {
            name: "Furret",
            cardNumber: "136",
            expansionName: "Darkness Ablaze",
            rarity: "Uncommon",
            cardVariantLabel: "Standard Set",
          },
        },
      ],
      diagnostics: [],
    });
    expect(dryRun.observations[0]?.sourceHash).toBeUndefined();
  });

  it("serves TCGplayer option transport through the ProviderAdapter boundary", async () => {
    const adapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      client: tcgplayerClient(),
    });

    await expect(adapter.listIntegrationUnits()).resolves.toEqual([
      {
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "tcgplayer",
        productDomain: "pokemon",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
        displayName: "TCGplayer Pokemon Single Cards",
        profileVersion: "2026.06.05",
      },
    ]);
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "product-lines",
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "3",
          label: "Pokemon",
          metadata: {
            productLineId: "3",
            productLineName: "Pokemon",
            productLineUrlName: "pokemon",
            isDirect: "true",
          },
        },
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "set-names",
        parentValues: { productLineId: "3" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "Prismatic Evolutions",
          label: "Prismatic Evolutions",
          parentValue: "3",
          metadata: expect.objectContaining({ setNameId: "2387", active: "true" }),
        }),
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "products",
        parentValues: { setName: "Prismatic Evolutions" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "610001",
          label: "Eevee ex",
          metadata: expect.objectContaining({ productLineName: "Pokemon", sealed: "false" }),
        }),
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "610001" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "7001001",
          label: "7001001",
          metadata: { sku: "7001001", condition: "Near Mint", variant: "Holofoil", language: "English" },
        },
        {
          value: "7001002",
          label: "7001002",
          metadata: { sku: "7001002", condition: "Lightly Played", variant: "Holofoil", language: "English" },
        },
      ],
    });
  });

  it("falls back to set-name search when TCGplayer product-line terms produce no scoped products", async () => {
    const listAllProductRequests: unknown[] = [];
    const pokemonBaseSetProduct = {
      ...tcgplayerAutomationResponseFixtures.productSearch.results[0].results[0],
      productId: 610101,
      productName: "Charizard",
      productLineId: 3,
      productLineName: "Pokemon",
      productTypeName: "Products",
      setId: 604,
      setName: "Base Set",
      sealed: false,
      customAttributes: { number: "4/102", releaseDate: "1999-01-09", cardType: ["Pokemon"] },
    };
    const magicBaseSetProduct = {
      ...pokemonBaseSetProduct,
      productId: 14240,
      productName: "Fury Sliver",
      productLineId: 1,
      productLineName: "Magic",
    };
    const pokemonBaseSetDetail = {
      ...tcgplayerAutomationResponseFixtures.productDetail,
      ...pokemonBaseSetProduct,
      productTypeName: "Cards",
      setCode: "BS",
      skus: [{ sku: 700610101, condition: "Near Mint", variant: "Holofoil", language: "English" }],
      listings: 42,
    };
    const adapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      client: {
        ...tcgplayerClient(),
        listAllProducts: async (input) => {
          listAllProductRequests.push(input);
          return input.filters?.term?.productLineName ? [] : [magicBaseSetProduct, pokemonBaseSetProduct];
        },
        getProductDetail: async ({ productId }) => {
          if (productId !== 610101) {
            throw new Error(`Unexpected product detail fetch for ${productId}.`);
          }
          return pokemonBaseSetDetail;
        },
      },
    });

    const plan = await adapter.planImport({
      unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "set-name",
      values: { productLineId: "3", productLineName: "Pokemon", setName: "Base Set" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));

    expect(payloads).toEqual([
      expect.objectContaining({
        externalKey: "product:610101",
        payload: expect.objectContaining({ kind: "product-detail", detail: pokemonBaseSetDetail }),
      }),
    ]);
    expect(listAllProductRequests).toEqual([
      expect.objectContaining({
        filters: { term: { productLineName: ["Pokemon"], setName: ["Base Set"] } },
      }),
      expect.objectContaining({
        filters: { term: { setName: ["Base Set"] } },
      }),
    ]);
  });

  it("settles TCGplayer set imports when authoritative details exclude generic search candidates", async () => {
    const progress: unknown[] = [];
    const cardSummary = {
      ...tcgplayerAutomationResponseFixtures.productSearch.results[0].results[0],
      productId: 610101,
      productName: "Charizard",
      productLineId: 3,
      productLineName: "Pokemon",
      productTypeName: "Products",
      setId: 604,
      setName: "Base Set",
      sealed: false,
    };
    const sealedSummary = {
      ...cardSummary,
      productId: 610102,
      productName: "Base Set Theme Deck",
    };
    const details = new Map<number, TcgplayerAutomationProductDetail>([
      [
        cardSummary.productId,
        {
          ...tcgplayerAutomationResponseFixtures.productDetail,
          ...cardSummary,
          productTypeName: "Cards",
          setCode: "BS",
          listings: 42,
        },
      ],
      [
        sealedSummary.productId,
        {
          ...tcgplayerAutomationResponseFixtures.productDetail,
          ...sealedSummary,
          productTypeName: "Sealed Products",
          sealed: true,
          setCode: "BS",
          listings: 7,
        },
      ],
    ]);
    const adapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      client: {
        ...tcgplayerClient(),
        listAllProducts: async () => [cardSummary, sealedSummary],
        getProductDetail: async ({ productId }) => {
          const detail = details.get(productId);
          if (!detail) {
            throw new Error(`Unexpected product detail fetch for ${productId}.`);
          }
          return detail;
        },
      },
    });

    const plan = await adapter.planImport({
      unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "set-name",
      values: { productLineId: "3", productLineName: "Pokemon", setName: "Base Set" },
    });
    const payloads = await collectPayloads(
      adapter.fetchPayloads(plan, {
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(payloads).toEqual([
      expect.objectContaining({
        externalKey: "product:610101",
        payload: expect.objectContaining({ kind: "product-detail" }),
      }),
    ]);
    expect(progress).toEqual([
      { phase: "fetching", completed: 0, total: 2, currentLabel: "Base Set" },
      { phase: "fetching", completed: 1, total: 2, currentLabel: "Charizard" },
      { phase: "fetching", completed: 2, total: 2, currentLabel: "Base Set Theme Deck" },
    ]);
  });

  it("serves TCGplayer Magic single-card transport through the active profile unit", async () => {
    const progress: unknown[] = [];
    const adapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerMtgProfileVersion(), requireTcgplayerPokemonProfileVersion()],
      client: magicTcgplayerClient(),
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    });

    await expect(adapter.listIntegrationUnits()).resolves.toEqual(
      expect.arrayContaining([
        {
          unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          providerKey: "tcgplayer",
          productDomain: "mtg",
          productForm: "single-card",
          ingestionPurpose: "source-observation-import",
          displayName: "TCGplayer Magic Single Cards",
          profileVersion: "2026.06.19",
        },
        expect.objectContaining({
          unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          displayName: "TCGplayer Pokemon Single Cards",
          productDomain: "pokemon",
          productForm: "single-card",
        }),
      ]),
    );
    await expect(adapter.listIntegrationUnits()).resolves.toHaveLength(2);
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "product-lines",
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "1",
          label: "Magic",
          metadata: expect.objectContaining({
            productLineId: "1",
            productLineName: "Magic",
            productLineUrlName: "magic",
          }),
        }),
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "set-names",
        parentValues: { productLineId: "1" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "Time Spiral",
          label: "Time Spiral",
          parentValue: "1",
          metadata: expect.objectContaining({ setNameId: "1001", active: "true" }),
        }),
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "products",
        parentValues: { setName: "Time Spiral" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "14240",
          label: "Fury Sliver",
          metadata: expect.objectContaining({ productLineName: "Magic", sealed: "false" }),
        }),
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "14240" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "50014240",
          label: "50014240",
          metadata: { sku: "50014240", condition: "Near Mint", variant: "Normal", language: "English" },
        },
      ],
    });

    const plan = await adapter.planImport({
      unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "set-name",
      values: { productLineId: "1", setName: "Time Spiral" },
    });
    const payloads = await collectPayloads(
      adapter.fetchPayloads(plan, {
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(plan).toMatchObject({
      unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      planKey: "tcgplayer:set:1:Time Spiral",
      transportSteps: [
        "Search TCGplayer products for set scope",
        "Fetch TCGplayer product details",
        "Attach payload provenance",
      ],
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "tcgplayer",
        externalKey: "product:14240",
        payload: {
          kind: "product-detail",
          detail: expect.objectContaining({
            productId: 14240,
            productName: "Fury Sliver",
            productLineName: "Magic",
            productTypeName: "Cards",
          }),
        },
      }),
    ]);
    expect(progress).toEqual([
      { phase: "fetching", completed: 0, total: 1, currentLabel: "Time Spiral" },
      { phase: "fetching", completed: 1, total: 1, currentLabel: "Fury Sliver" },
    ]);
  });

  it("serves TCGplayer Magic sealed-product transport through the active profile unit", async () => {
    const progress: unknown[] = [];
    const adapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [
        requireTcgplayerMtgProfileVersion(),
        requireTcgplayerMtgSealedProfileVersion(),
        requireTcgplayerPokemonProfileVersion(),
      ],
      client: magicTcgplayerClient(),
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    });

    await expect(adapter.listIntegrationUnits()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          displayName: "TCGplayer Magic Single Cards",
          productForm: "single-card",
        }),
        expect.objectContaining({
          unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          displayName: "TCGplayer Magic Sealed Products",
          productForm: "sealed-product",
        }),
        expect.objectContaining({
          unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
          displayName: "TCGplayer Pokemon Single Cards",
          productForm: "single-card",
        }),
      ]),
    );
    await expect(adapter.listIntegrationUnits()).resolves.toHaveLength(3);
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "products",
        parentValues: { setName: "Time Spiral" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "96601",
          label: "Time Spiral Booster Pack",
          metadata: expect.objectContaining({ productLineName: "Magic", sealed: "true" }),
        }),
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "96601" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "50096601",
          label: "50096601",
          metadata: { sku: "50096601", condition: "Sealed", variant: "Sealed", language: "English" },
        },
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "14240" },
      }),
    ).resolves.toEqual({ items: [] });

    const plan = await adapter.planImport({
      unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "set-name",
      values: { productLineId: "1", setName: "Time Spiral" },
    });
    const payloads = await collectPayloads(
      adapter.fetchPayloads(plan, {
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(plan).toMatchObject({
      unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      planKey: "tcgplayer:set:1:Time Spiral",
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "tcgplayer",
        externalKey: "product:96601",
        payload: {
          kind: "product-detail",
          detail: expect.objectContaining({
            productId: 96601,
            productName: "Time Spiral Booster Pack",
            productLineName: "Magic",
            productTypeName: "Sealed Products",
            sealed: true,
          }),
        },
      }),
    ]);
    expect(progress).toEqual([
      { phase: "fetching", completed: 0, total: 1, currentLabel: "Time Spiral" },
      { phase: "fetching", completed: 1, total: 1, currentLabel: "Time Spiral Booster Pack" },
    ]);

    const rejectedPlan = await adapter.planImport({
      unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "product",
      values: { productId: "14240" },
    });
    await expect(collectPayloads(adapter.fetchPayloads(rejectedPlan))).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "product-detail-failure",
          reason: expect.stringContaining("only imports Magic sealed products"),
        }),
      }),
    ]);
  });

  it("reuses the TCGplayer provider path for Yu-Gi-Oh single-card unit constraints", async () => {
    const yugiohAdapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [tcgplayerYugiohProfileVersion()],
      client: yugiohTcgplayerClient(),
      now: () => new Date("2026-06-20T00:00:00.000Z"),
    });

    await expect(yugiohAdapter.listIntegrationUnits()).resolves.toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        productDomain: "yugioh",
        productForm: "single-card",
        displayName: "TCGplayer Yu-Gi-Oh Single Cards",
      }),
    ]);
    await expect(
      yugiohAdapter.listOptions({
        unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "product-lines",
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ value: "2", label: "Yu-Gi-Oh!" }),
        expect.objectContaining({ value: "20", label: "YuGiOh" }),
        expect.objectContaining({ value: "21", label: "Yugioh" }),
        expect.objectContaining({ value: "22", label: "Yu-Gi-Oh" }),
        expect.objectContaining({ value: "23", label: "yugioh" }),
      ],
    });

    const mtgAdapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerMtgProfileVersion()],
      client: yugiohTcgplayerClient(),
    });
    const pokemonAdapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      client: yugiohTcgplayerClient(),
    });

    await expect(
      mtgAdapter.listOptions({
        unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "product-lines",
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ value: "1", label: "Magic" })],
    });
    await expect(
      pokemonAdapter.listOptions({
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "product-lines",
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ value: "3", label: "Pokemon" })],
    });

    await expect(
      yugiohAdapter.listOptions({
        unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "set-names",
        parentValues: { productLineId: "2" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "Legend of Blue Eyes White Dragon",
          label: "Legend of Blue Eyes White Dragon",
          parentValue: "2",
        }),
      ],
    });
    await expect(
      yugiohAdapter.listOptions({
        unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "products",
        parentValues: { productLineName: "YuGiOh", setName: "Legend of Blue Eyes White Dragon" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "721337",
          label: "Blue-Eyes White Dragon",
          metadata: expect.objectContaining({ productLineName: "Yu-Gi-Oh!", sealed: "false" }),
        }),
      ],
    });
    await expect(
      yugiohAdapter.listOptions({
        unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "721337" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "800721337",
          label: "800721337",
          metadata: { sku: "800721337", condition: "Near Mint", variant: "1st Edition", language: "English" },
        },
      ],
    });

    const acceptedPlan = await yugiohAdapter.planImport({
      unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "set-name",
      values: { productLineName: "yugioh", setName: "Legend of Blue Eyes White Dragon" },
    });
    await expect(collectPayloads(yugiohAdapter.fetchPayloads(acceptedPlan))).resolves.toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "product:721337",
        payload: {
          kind: "product-detail",
          detail: expect.objectContaining({
            productId: 721337,
            productLineName: "Yu-Gi-Oh!",
            productTypeName: "Cards",
          }),
        },
      }),
    ]);

    const rejectedPlan = await yugiohAdapter.planImport({
      unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "product",
      values: { productId: "14240" },
    });
    await expect(collectPayloads(yugiohAdapter.fetchPayloads(rejectedPlan))).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "product-detail-failure",
          reason: expect.stringContaining("only imports Yu-Gi-Oh! single-card products"),
        }),
      }),
    ]);
  });

  it("reuses the TCGplayer provider path for One Piece single-card unit constraints", async () => {
    const onePieceAdapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerOnePieceProfileVersion()],
      client: onePieceTcgplayerClient(),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    await expect(onePieceAdapter.listIntegrationUnits()).resolves.toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        productDomain: "one-piece",
        productForm: "single-card",
        displayName: "TCGplayer One Piece Single Cards",
      }),
    ]);
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "product-lines",
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ value: "68", label: "One Piece Card Game" })],
    });
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "set-names",
        parentValues: { productLineId: "68" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "Romance Dawn",
          label: "Romance Dawn",
          parentValue: "68",
        }),
      ],
    });
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "set-names",
        parentValues: { productLineId: "1" },
      }),
    ).rejects.toThrow("One Piece Card Game product line");
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "products",
        parentValues: { productLineName: "One Piece Card Game", setName: "Romance Dawn" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "987650",
          label: "Monkey.D.Luffy",
          metadata: expect.objectContaining({ productLineName: "One Piece Card Game", sealed: "false" }),
        }),
      ],
    });
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "987650" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "900987650",
          label: "900987650",
          metadata: { sku: "900987650", condition: "Near Mint", variant: "Normal", language: "English" },
        },
      ],
    });

    const acceptedPlan = await onePieceAdapter.planImport({
      unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "set-name",
      values: { productLineId: "68", setName: "Romance Dawn" },
    });
    await expect(collectPayloads(onePieceAdapter.fetchPayloads(acceptedPlan))).resolves.toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "product:987650",
        payload: {
          kind: "product-detail",
          detail: expect.objectContaining({
            productId: 987650,
            productLineId: 68,
            productLineName: "One Piece Card Game",
            productTypeName: "Cards",
          }),
        },
      }),
    ]);

    const rejectedPlan = await onePieceAdapter.planImport({
      unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "product",
      values: { productId: "14240" },
    });
    await expect(collectPayloads(onePieceAdapter.fetchPayloads(rejectedPlan))).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "product-detail-failure",
          reason: expect.stringContaining("only imports One Piece Card Game single-card products"),
        }),
      }),
    ]);
  });

  it("serves TCGplayer One Piece sealed-product transport through the active profile unit", async () => {
    const progress: unknown[] = [];
    const onePieceAdapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [
        requireTcgplayerOnePieceProfileVersion(),
        requireTcgplayerOnePieceSealedProfileVersion(),
      ],
      client: onePieceTcgplayerClient(),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
    });

    await expect(onePieceAdapter.listIntegrationUnits()).resolves.toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        productDomain: "one-piece",
        productForm: "single-card",
      }),
      expect.objectContaining({
        unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        productDomain: "one-piece",
        productForm: "sealed-product",
        displayName: "TCGplayer One Piece Sealed Products",
      }),
    ]);
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "product-lines",
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ value: "68", label: "One Piece Card Game" })],
    });
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "products",
        parentValues: { productLineName: "One Piece Card Game", setName: "Romance Dawn" },
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          value: "987660",
          label: "Romance Dawn Booster Box",
          metadata: expect.objectContaining({ productLineName: "One Piece Card Game", sealed: "true" }),
        }),
      ],
    });
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "987660" },
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "900987660",
          label: "900987660",
          metadata: { sku: "900987660", condition: "Sealed", variant: "Sealed", language: "English" },
        },
      ],
    });
    await expect(
      onePieceAdapter.listOptions({
        unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "skus",
        parentValues: { productId: "987650" },
      }),
    ).resolves.toEqual({ items: [] });

    const acceptedPlan = await onePieceAdapter.planImport({
      unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "set-name",
      values: { productLineId: "68", setName: "Romance Dawn" },
    });
    await expect(
      collectPayloads(
        onePieceAdapter.fetchPayloads(acceptedPlan, {
          onProgress: (event) => {
            progress.push(event);
          },
        }),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "tcgplayer",
        externalKey: "product:987660",
        payload: {
          kind: "product-detail",
          detail: expect.objectContaining({
            productId: 987660,
            productLineId: 68,
            productLineName: "One Piece Card Game",
            productTypeName: "Sealed Products",
            sealed: true,
            skus: [{ sku: 900987660, condition: "Sealed", variant: "Sealed", language: "English" }],
          }),
        },
      }),
    ]);
    expect(acceptedPlan).toMatchObject({
      unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      planKey: "tcgplayer:set:68:Romance Dawn",
    });
    expect(progress).toEqual([
      { phase: "fetching", completed: 0, total: 1, currentLabel: "Romance Dawn" },
      { phase: "fetching", completed: 1, total: 1, currentLabel: "Romance Dawn Booster Box" },
    ]);

    const rejectedPlan = await onePieceAdapter.planImport({
      unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "product",
      values: { productId: "987650" },
    });
    await expect(collectPayloads(onePieceAdapter.fetchPayloads(rejectedPlan))).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "product-detail-failure",
          reason: expect.stringContaining("only imports One Piece Card Game sealed products"),
        }),
      }),
    ]);
  });

  it("plans and fetches TCGplayer product detail payloads with typed provenance", async () => {
    const progress: unknown[] = [];
    const adapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      client: tcgplayerClient(),
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    });
    const plan = await adapter.planImport({
      unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "product",
      values: { productId: "610001" },
    });
    const payloads = await collectPayloads(
      adapter.fetchPayloads(plan, {
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(plan).toMatchObject({
      unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      planKey: "tcgplayer:product:610001",
      transportSteps: ["Fetch TCGplayer product detail", "Attach payload provenance"],
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "tcgplayer",
        externalKey: "product:610001",
        provenance: {
          fetchedAt: "2026-06-06T00:00:00.000Z",
          sourceUpdatedAt: "2025-01-17",
          sourceUrl: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
        },
        payload: {
          kind: "product-detail",
          detail: expect.objectContaining({ productId: 610001, productName: "Eevee ex" }),
        },
      }),
    ]);
    expect(progress).toEqual([
      { phase: "fetching", completed: 0, total: 1, currentLabel: "Product 610001" },
      { phase: "fetching", completed: 1, total: 1, currentLabel: "Eevee ex" },
    ]);
  });

  it("keeps TCGplayer adapter diagnostics transport-only and secret-free", async () => {
    const configured = await createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      client: tcgplayerClient(),
    }).getTransportDiagnostics();
    const unconfigured = await createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
    }).getTransportDiagnostics();

    expect(configured).toEqual([
      expect.objectContaining({
        code: "tcgplayer-automation-client-configured",
        severity: "info",
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      }),
      expect.objectContaining({
        code: "tcgplayer-domain-rate-limit-policy-configured",
        severity: "info",
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      }),
    ]);
    expect(unconfigured).toEqual([
      expect.objectContaining({
        code: "tcgplayer-automation-client-unconfigured",
        severity: "error",
      }),
      expect.objectContaining({
        code: "tcgplayer-domain-rate-limit-policy-configured",
        severity: "info",
      }),
    ]);
    expect(JSON.stringify([...configured, ...unconfigured])).not.toMatch(
      /TCGAuthTicket|cookie|secret|promotion|replay/i,
    );
  });

  it("reports TCGplayer credential readiness without exposing credential material", async () => {
    const configured = await createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      client: tcgplayerClient(),
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    }).getCredentialReadiness();
    const unconfigured = await createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerPokemonProfileVersion()],
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    }).getCredentialReadiness();

    expect(configured).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        requirement: "required",
        sourceKind: "environment-secret",
        state: "configured",
        importBlocking: false,
        diagnosticCode: null,
      }),
    ]);
    expect(unconfigured).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        requirement: "required",
        sourceKind: "environment-secret",
        state: "missing",
        importBlocking: true,
        diagnosticCode: "credential-missing",
      }),
    ]);
    expect(JSON.stringify([...configured, ...unconfigured])).not.toMatch(
      /TCGAuthTicket|password|Bearer|authorization/i,
    );
  });

  it("validates MTGJSON reference data through ProviderAdapter extension points", async () => {
    const adapter = createMtgjsonValidationProviderAdapter();
    const units = await adapter.listIntegrationUnits();
    const sets = await adapter.listOptions({
      unitKey: MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
      optionKind: "sets",
    });
    const cards = await adapter.listOptions({
      unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      optionKind: "cards",
      parentValues: { setCode: "TSP" },
    });
    const plan = await adapter.planImport({
      unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "single-card",
      values: { setCode: "TSP", cardName: "Fury Sliver", collectorNumber: "157" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));
    const dryRun = await runMtgjsonSourceObservationValidationDryRun(adapter);

    expect(units.map((unit) => unit.unitKey)).toEqual([
      MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
    ]);
    expect(sets.items).toContainEqual(
      expect.objectContaining({
        value: "TSP",
        label: "Time Spiral",
        metadata: expect.objectContaining({ mtgjsonVersion: "5.3.0+20260605" }),
      }),
    );
    expect(cards.items).toContainEqual(
      expect.objectContaining({
        label: "Fury Sliver #157",
        parentValue: "TSP",
        metadata: expect.objectContaining({ scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe" }),
      }),
    );
    expect(plan.transportSteps).toEqual([
      "Fetch MTGJSON set file",
      "Select card payload",
      "Attach card reference provenance",
    ]);
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
        providerKey: "mtgjson",
        externalKey: "card:13fd9d47-9aa7-5f7c-8f47-fury-sliver",
        provenance: expect.objectContaining({
          fetchedAt: "2026-06-08T00:00:00.000Z",
          sourceUrl: "https://mtgjson.com/api/v5/TSP.json",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(dryRun).toMatchObject({
      unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      profileVersion: "mtgjson-validation-2026.06.08",
      observations: [
        {
          providerKey: "mtgjson",
          normalizedFacts: {
            name: "Fury Sliver",
            cardNumber: "157",
            setCode: "TSP",
            setName: "Time Spiral",
            rarity: "uncommon",
            layout: "normal",
            scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
          },
        },
      ],
      diagnostics: [],
    });
  });

  it("validates LorcanaJSON reference data through bulk-first ProviderAdapter extension points", async () => {
    const adapter = createLorcanajsonValidationProviderAdapter();
    const units = await adapter.listIntegrationUnits();
    const sets = await adapter.listOptions({
      unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      optionKind: "sets",
    });
    const cards = await adapter.listOptions({
      unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      optionKind: "cards",
      parentValues: { setCode: "1" },
    });
    const plan = await adapter.planImport({
      unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "single-card",
      values: { setCode: "1", cardName: "Elsa - Snow Queen", cardNumber: "41" },
    });
    const setPlan = await adapter.planImport({
      unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-name",
      values: { setId: "1", setName: "The First Chapter" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));
    const setPayloads = await collectPayloads(adapter.fetchPayloads(setPlan));
    const dryRun = await runLorcanajsonCardReferenceValidationDryRun(adapter);

    expect(units.map((unit) => unit.unitKey)).toEqual([
      LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    ]);
    expect(sets.items).toContainEqual(
      expect.objectContaining({
        value: "1",
        label: "The First Chapter",
        metadata: expect.objectContaining({ cardCount: "1", formatVersion: "2.3.2" }),
      }),
    );
    expect(cards.items).toContainEqual(
      expect.objectContaining({
        value: "1-041",
        label: "Elsa - Snow Queen #41",
        parentValue: "1",
        metadata: expect.objectContaining({ tcgplayerProductId: "1005010", inkColor: "Amethyst" }),
      }),
    );
    expect(plan.transportSteps).toEqual([
      "Fetch LorcanaJSON set file",
      "Select requested card payload",
      "Attach card reference provenance",
    ]);
    expect(plan.usageEstimate).toMatchObject({
      requestStrategy: "bulk-first",
      estimatedRequestCount: 1,
      perRecordFallbackReason: null,
    });
    expect(setPlan).toMatchObject({
      unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      planKey: "lorcanajson:set:1",
      scope: expect.objectContaining({
        values: expect.objectContaining({ setCode: "1", setId: "1", setName: "The First Chapter" }),
      }),
      estimatedPayloads: 1,
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
        providerKey: "lorcanajson",
        externalKey: "card:1-041",
        payload: expect.objectContaining({
          kind: "lorcana-card-reference",
          cardId: "1-041",
          setName: "The First Chapter",
          tcgplayerProductId: "1005010",
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
        }),
        provenance: expect.objectContaining({
          fetchedAt: "2026-06-23T00:00:00.000Z",
          sourceUrl: "https://lorcanajson.org/files/current/en/sets/setdata.1.json",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(setPayloads).toEqual([
      expect.objectContaining({
        unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "lorcanajson",
        externalKey: "set:1",
        payload: expect.objectContaining({
          kind: "lorcana-set-reference",
          setCode: "1",
          setName: "The First Chapter",
        }),
      }),
    ]);
    expect(dryRun).toMatchObject({
      unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      profileVersion: "lorcanajson-validation-2026.06.23",
      observations: [
        {
          providerKey: "lorcanajson",
          normalizedFacts: {
            name: "Elsa - Snow Queen",
            cardNumber: "41",
            setCode: "1",
            setName: "The First Chapter",
            rarity: "Super Rare",
            cardType: "Storyborn Hero Queen",
            inkColor: "Amethyst",
            tcgplayerProductId: "1005010",
          },
        },
      ],
      diagnostics: [],
    });
  });

  it("fails LorcanaJSON payload fetches with a terminal timeout instead of hanging", async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as typeof globalThis.fetch;
    const adapter = createLorcanajsonProviderAdapter({ fetch, fetchTimeoutMs: 1 });
    const plan = await adapter.planImport({
      unitKey: LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set",
      values: { setCode: "1" },
    });

    await expect(collectPayloads(adapter.fetchPayloads(plan))).rejects.toThrow(
      "LorcanaJSON request timed out before the provider returned a response.",
    );
  });

  it("validates Lorcast reference data through public API ProviderAdapter extension points", async () => {
    const adapter = createLorcastValidationProviderAdapter();
    const units = await adapter.listIntegrationUnits();
    const sets = await adapter.listOptions({
      unitKey: LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      optionKind: "sets",
    });
    const cards = await adapter.listOptions({
      unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      optionKind: "cards",
      parentValues: { setCode: "1" },
    });
    const plan = await adapter.planImport({
      unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "single-card",
      values: { setCode: "1", cardName: "Elsa - Snow Queen", cardNumber: "41" },
    });
    const setPlan = await adapter.planImport({
      unitKey: LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-name",
      values: { setId: "1", setName: "The First Chapter" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));
    const setPayloads = await collectPayloads(adapter.fetchPayloads(setPlan));
    const dryRun = await runLorcastCardReferenceValidationDryRun(adapter);
    const diagnostics = await adapter.getTransportDiagnostics();

    expect(units.map((unit) => unit.unitKey)).toEqual([
      LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    ]);
    expect(sets.items).toContainEqual(
      expect.objectContaining({
        value: "1",
        label: "The First Chapter",
        metadata: expect.objectContaining({ cacheGuidance: "cache-at-least-24h" }),
      }),
    );
    expect(cards.items).toContainEqual(
      expect.objectContaining({
        value: "crd_elsa_snow_queen_1_041",
        label: "Elsa - Snow Queen #41",
        parentValue: "1",
        metadata: expect.objectContaining({ tcgplayerProductId: "1005010", inkColor: "Amethyst" }),
      }),
    );
    expect(plan.transportSteps).toEqual([
      "Fetch Lorcast set cards endpoint",
      "Select requested card payload",
      "Attach card reference provenance",
      "Prefer cached set payloads for repeat diagnostics",
    ]);
    expect(plan.usageEstimate).toMatchObject({
      requestStrategy: "bulk-first",
      estimatedRequestCount: 1,
      creditDiagnostic: "Lorcast is a public API with no credentialed usage or credit endpoint.",
    });
    expect(setPlan).toMatchObject({
      unitKey: LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      planKey: "lorcast:set:1",
      scope: expect.objectContaining({
        values: expect.objectContaining({ setCode: "1", setId: "1", setName: "The First Chapter" }),
      }),
      estimatedPayloads: 1,
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
        providerKey: "lorcast",
        externalKey: "card:crd_elsa_snow_queen_1_041",
        payload: expect.objectContaining({
          kind: "lorcana-card-reference",
          cardId: "crd_elsa_snow_queen_1_041",
          setName: "The First Chapter",
          tcgplayerProductId: "1005010",
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
        }),
        provenance: expect.objectContaining({
          fetchedAt: "2026-06-23T00:00:00.000Z",
          sourceUrl: "https://api.lorcast.com/v0/sets/1/cards",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(setPayloads).toEqual([
      expect.objectContaining({
        unitKey: LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "lorcast",
        externalKey: "set:set_7ecb0e0c71af496a9e0110e23824e0a5",
        payload: expect.objectContaining({
          kind: "lorcana-set-reference",
          setCode: "1",
          setName: "The First Chapter",
        }),
      }),
    ]);
    expect(JSON.stringify(payloads)).not.toMatch(/usd|price|seller|inventory/i);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "lorcast-public-api-transport-configured",
        message: expect.stringContaining("cache downloaded data for at least 24 hours"),
      }),
      expect.objectContaining({
        code: "lorcast-public-api-transport-configured",
        message: expect.stringContaining("cache downloaded data for at least 24 hours"),
      }),
    ]);
    expect(dryRun).toMatchObject({
      unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      profileVersion: "lorcast-validation-2026.06.23",
      observations: [
        {
          providerKey: "lorcast",
          normalizedFacts: {
            name: "Elsa - Snow Queen",
            cardNumber: "41",
            setCode: "1",
            setName: "The First Chapter",
            rarity: "Super_rare",
            cardType: "Character",
            inkColor: "Amethyst",
            tcgplayerProductId: "1005010",
          },
        },
      ],
      diagnostics: [],
    });
  });

  it("validates Scryfall reference and image evidence through ProviderAdapter extension points", async () => {
    const adapter = createScryfallValidationProviderAdapter();
    const units = await adapter.listIntegrationUnits();
    const cards = await adapter.listOptions({
      unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      optionKind: "cards",
      parentValues: { query: '!"Fury Sliver"' },
    });
    const bulk = await adapter.listOptions({
      unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      optionKind: "bulk-data",
    });
    const imagePlan = await adapter.planImport({
      unitKey: SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
      scopeKey: "image-evidence",
      values: { cardId: "0000579f-7b35-4ed3-b44c-db2a538066fe" },
    });
    const imagePayloads = await collectPayloads(adapter.fetchPayloads(imagePlan));
    const dryRun = await runScryfallSourceObservationValidationDryRun(adapter);

    expect(units.map((unit) => unit.unitKey)).toEqual([
      SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
    ]);
    expect(cards.items).toEqual([
      expect.objectContaining({
        value: "0000579f-7b35-4ed3-b44c-db2a538066fe",
        label: "Fury Sliver - TSP - 157",
        metadata: expect.objectContaining({ imageStatus: "highres_scan" }),
      }),
    ]);
    expect(bulk.items).toEqual([
      expect.objectContaining({
        value: "default_cards",
        label: "Default Cards",
        metadata: expect.objectContaining({ updatedAt: "2026-06-08T09:13:03.704+00:00" }),
      }),
    ]);
    expect(imagePayloads).toEqual([
      expect.objectContaining({
        unitKey: SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
        providerKey: "scryfall",
        externalKey: "image:0000579f-7b35-4ed3-b44c-db2a538066fe",
        payload: expect.objectContaining({
          kind: "image-evidence",
          imageUris: expect.objectContaining({ normal: expect.stringContaining("cards.scryfall.io/normal") }),
        }),
      }),
    ]);
    expect(dryRun).toMatchObject({
      unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      profileVersion: "scryfall-validation-2026.06.08",
      observations: [
        {
          providerKey: "scryfall",
          normalizedFacts: {
            name: "Fury Sliver",
            cardNumber: "157",
            setCode: "tsp",
            setName: "Time Spiral",
            rarity: "uncommon",
            layout: "normal",
            oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
            imageStatus: "highres_scan",
          },
        },
      ],
      diagnostics: [],
    });
  });

  it("validates TCGplayer source-observation imports through fixture-backed proof dry runs", async () => {
    const singleCard = await runTcgplayerMtgSingleCardSourceObservationImportProofDryRun();
    const sealedProduct = await runTcgplayerMtgSealedProductSourceObservationImportProofDryRun();
    const onePieceSealedProduct = await runTcgplayerOnePieceSealedProductSourceObservationImportProofDryRun();
    const lorcanaSingleCard = await runTcgplayerLorcanaSingleCardSourceObservationImportProofDryRun();
    const lorcanaSealedProduct = await runTcgplayerLorcanaSealedProductSourceObservationImportProofDryRun();

    expect(singleCard).toMatchObject({
      unitKey: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      profileVersion: "2026.06.19",
      observations: [
        {
          providerKey: "tcgplayer",
          externalKey: "product:14240",
          normalizedFacts: {
            productId: "14240",
            name: "Fury Sliver",
            setCode: "TSP",
            setName: "Time Spiral",
            productLineName: "Magic",
            productTypeName: "Cards",
            productForm: "single",
            cardNumber: "157",
            releaseDate: "2006-10-06",
            skuCount: "1",
          },
        },
      ],
      diagnostics: [],
    });
    expect(sealedProduct).toMatchObject({
      unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      profileVersion: "2026.06.19",
      observations: [
        {
          providerKey: "tcgplayer",
          externalKey: "product:96601",
          normalizedFacts: {
            productId: "96601",
            name: "Time Spiral Booster Pack",
            setCode: "TSP",
            setName: "Time Spiral",
            productLineName: "Magic",
            productTypeName: "Sealed Products",
            productForm: "sealed",
            cardNumber: "PACK",
            releaseDate: "2006-10-06",
            skuCount: "1",
          },
        },
      ],
      diagnostics: [],
    });
    expect(onePieceSealedProduct).toMatchObject({
      unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      profileVersion: "2026.06.23",
      observations: [
        {
          providerKey: "tcgplayer",
          externalKey: "product:987660",
          normalizedFacts: {
            productId: "987660",
            name: "Romance Dawn Booster Box",
            setCode: "OP-01",
            setName: "Romance Dawn",
            productLineName: "One Piece Card Game",
            productTypeName: "Sealed Products",
            productForm: "sealed",
            cardNumber: "BOX",
            releaseDate: "2022-12-02",
            skuCount: "1",
            firstSkuId: "900987660",
            firstSkuCondition: "Sealed",
            firstSkuVariant: "Sealed",
            firstSkuLanguage: "English",
          },
        },
      ],
      diagnostics: [],
    });
    expect(JSON.stringify(onePieceSealedProduct)).not.toMatch(/marketPrice|lowestPrice|medianPrice|listings|seller/i);
    expect(lorcanaSingleCard).toMatchObject({
      unitKey: TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      profileVersion: "2026.06.23",
      observations: [
        {
          providerKey: "tcgplayer",
          externalKey: "product:1005010",
          normalizedFacts: {
            productId: "1005010",
            name: "Elsa - Snow Queen",
            setCode: "TFC",
            setName: "The First Chapter",
            productLineName: "Disney Lorcana",
            productTypeName: "Cards",
            productForm: "single",
            cardNumber: "3/204",
            releaseDate: "2023-08-18",
            skuCount: "1",
            firstSkuId: "91005010",
          },
        },
      ],
      diagnostics: [],
    });
    expect(lorcanaSealedProduct).toMatchObject({
      unitKey: TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      profileVersion: "2026.06.23",
      observations: [
        {
          providerKey: "tcgplayer",
          externalKey: "product:1005020",
          normalizedFacts: {
            productId: "1005020",
            name: "The First Chapter Booster Box",
            setCode: "TFC",
            setName: "The First Chapter",
            productLineName: "Disney Lorcana",
            productTypeName: "Sealed Products",
            productForm: "sealed",
            cardNumber: "BOX",
            releaseDate: "2023-08-18",
            skuCount: "1",
            firstSkuId: "91005020",
            firstSkuCondition: "Sealed",
            firstSkuVariant: "Sealed",
            firstSkuLanguage: "English",
          },
        },
      ],
      diagnostics: [],
    });
    expect(JSON.stringify(lorcanaSingleCard)).not.toMatch(/marketPrice|lowestPrice|medianPrice|listings|seller/i);
    expect(JSON.stringify(lorcanaSealedProduct)).not.toMatch(/marketPrice|lowestPrice|medianPrice|listings|seller/i);
  });

  it("records MTGJSON/Scryfall source conflict evidence without adapter-side precedence", async () => {
    const mtgjson = await runMtgjsonSourceObservationValidationDryRun();
    const scryfall = await runScryfallSourceObservationValidationDryRun();
    const mtgjsonConflictObservation = {
      ...mtgjson.observations[0],
      normalizedFacts: {
        ...mtgjson.observations[0]?.normalizedFacts,
        rarity: "special",
      },
    };
    const conflictEvidence = {
      field: "rarity",
      winningValue: scryfall.observations[0]?.normalizedFacts.rarity,
      winningSource: scryfall.observations[0]?.providerKey,
      losingValues: [
        {
          value: mtgjsonConflictObservation.normalizedFacts.rarity,
          source: mtgjsonConflictObservation.providerKey,
          externalKey: mtgjsonConflictObservation.externalKey,
        },
      ],
      rule: "field-precedence.mtg-card-print.v1",
      explanation:
        "Scryfall print data wins card-print rarity conflicts; MTGJSON retains the losing source value as evidence for operator review.",
    };

    expect(conflictEvidence).toEqual({
      field: "rarity",
      winningValue: "uncommon",
      winningSource: "scryfall",
      losingValues: [
        {
          value: "special",
          source: "mtgjson",
          externalKey: "card:13fd9d47-9aa7-5f7c-8f47-fury-sliver",
        },
      ],
      rule: "field-precedence.mtg-card-print.v1",
      explanation:
        "Scryfall print data wins card-print rarity conflicts; MTGJSON retains the losing source value as evidence for operator review.",
    });
    expect(JSON.stringify(conflictEvidence)).not.toMatch(/adapter.*wins|provider.*decides/i);
  });

  it("keeps MTGJSON and Scryfall validation adapters out of core runtime, routes, Admin branches, and raw JSON paths", () => {
    const guardedFiles = [
      new URL("../runtime.ts", import.meta.url),
      new URL("../route.ts", import.meta.url),
      new URL("../route-modules/route-helpers.ts", import.meta.url),
      new URL("../../ui/workbench-shell.tsx", import.meta.url),
      new URL("../../ui/integrations-surface-page.tsx", import.meta.url),
      new URL("../../ui/workbench-workspace-renderers.tsx", import.meta.url),
    ];

    for (const fileUrl of guardedFiles) {
      const file = fileURLToPath(fileUrl);
      const source = readFileSync(file, "utf8");

      expect(source, file).not.toMatch(/MTGJSON_VALIDATION|mtgjson-validation|createMtgjsonValidationProviderAdapter/i);
      expect(source, file).not.toMatch(
        /SCRYFALL_VALIDATION|scryfall-validation|createScryfallValidationProviderAdapter/i,
      );
    }
  });
});

function referenceCardsAdapter(): ProviderAdapter<ReferenceCardPayload> {
  return {
    providerKey: "reference-cards",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      return [referencePokemonUnit, referenceMtgUnit];
    },
    async listOptions(input) {
      if (input.unitKey !== referencePokemonUnit.unitKey || input.optionKind !== "fixture-card") {
        return { items: [] };
      }

      return {
        items: [{ value: "abra-43", label: "Abra 43/102" }],
      };
    },
    async planImport(scope) {
      return {
        unitKey: scope.unitKey,
        planKey: `${scope.unitKey}:${scope.scopeKey}`,
        scope,
        estimatedPayloads: 1,
        transportSteps: ["load-fixture-payload"],
      };
    },
    async *fetchPayloads(plan: ProviderImportPlan): AsyncIterable<ProviderPayloadEnvelope<ReferenceCardPayload>> {
      yield {
        unitKey: plan.unitKey,
        providerKey: "reference-cards",
        externalKey: "abra-43",
        payload: {
          providerCardId: "abra-43",
          name: "Abra 43/102",
        },
        provenance: {
          fetchedAt: "2026-06-05T00:00:00.000Z",
          sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
          contentHash: "reference-hash-abra-43",
        },
      };
    },
    async getTransportDiagnostics() {
      return [
        {
          code: "reference-fixtures-ready",
          severity: "info",
          message: "Reference fixture payloads are available.",
        },
      ];
    },
    async getCredentialReadiness() {
      return [
        {
          providerKey: "reference-cards",
          requirement: "not-required",
          sourceKind: "none",
          state: "not-required",
          importBlocking: false,
          optionQueryBlocking: false,
          diagnosticCode: null,
          message: "Reference fixture payloads do not require provider credentials.",
          checkedAt: null,
          scope: {},
          evidence: { fixtureBacked: true },
        },
      ];
    },
  };
}

async function collectPayloads<TPayload>(
  payloads: AsyncIterable<ProviderPayloadEnvelope<TPayload>>,
): Promise<ProviderPayloadEnvelope<TPayload>[]> {
  const collected: ProviderPayloadEnvelope<TPayload>[] = [];

  for await (const payload of payloads) {
    collected.push(payload);
  }

  return collected;
}

function requireTcgdexProfileVersion() {
  const version = getActiveCatalogProviderIntegrationProfileVersion("tcgdex");
  if (!version) {
    throw new Error("Expected active TCGdex profile version.");
  }
  return version;
}

function requireTcgplayerPokemonProfileVersion() {
  const version = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.05", {
    profileKey: "pokemon-single-card-product-sku",
  });
  if (!version) {
    throw new Error("Expected TCGplayer Pokemon profile version.");
  }
  return version;
}

function requireTcgplayerMtgProfileVersion() {
  const version = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.19", {
    profileKey: "mtg-single-card-product-sku",
  });
  if (!version) {
    throw new Error("Expected TCGplayer Magic profile version.");
  }
  return version;
}

function requireTcgplayerMtgSealedProfileVersion() {
  const version = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.19", {
    profileKey: "mtg-sealed-product-sku",
  });
  if (!version) {
    throw new Error("Expected TCGplayer Magic sealed profile version.");
  }
  return version;
}

function requireTcgplayerOnePieceProfileVersion() {
  const version = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.22", {
    profileKey: "one-piece-single-card-product-sku",
  });
  if (!version) {
    throw new Error("Expected TCGplayer One Piece profile version.");
  }
  return version;
}

function requireTcgplayerOnePieceSealedProfileVersion() {
  const version = getCatalogProviderIntegrationProfileVersion("tcgplayer", "2026.06.23", {
    profileKey: "one-piece-sealed-product-sku",
  });
  if (!version) {
    throw new Error("Expected TCGplayer One Piece sealed profile version.");
  }
  return version;
}

function tcgplayerYugiohProfileVersion(): CatalogProviderIntegrationProfileVersionRecord {
  const base = requireTcgplayerPokemonProfileVersion();
  return {
    providerKey: "tcgplayer",
    profileKey: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.profileKey,
    profileVersion: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity:
      tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: {
      ...base.profile,
      displayName: "TCGplayer Yu-Gi-Oh Single Cards",
      status: "active",
      normalizedObservationMapping: {
        ...base.profile.normalizedObservationMapping,
        unknownVariantLabelPrefix: "Unclassified TCGplayer Yu-Gi-Oh Variant",
      },
    },
    sourceContract: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract,
  };
}

function tcgplayerClient(): TcgplayerAutomationCatalogClient {
  return {
    listProductLines: async () => tcgplayerAutomationResponseFixtures.productLines,
    listCatalogSetNames: async () => tcgplayerAutomationResponseFixtures.catalogSetNames,
    searchProducts: async () => tcgplayerAutomationResponseFixtures.productSearch,
    listAllProducts: async () => tcgplayerAutomationResponseFixtures.productSearch.results[0].results,
    getProductDetail: async () => tcgplayerAutomationResponseFixtures.productDetail,
  };
}

function magicTcgplayerClient(): TcgplayerAutomationCatalogClient {
  const details = new Map([
    [
      14240,
      {
        productTypeName: "Cards",
        rarityName: "Uncommon",
        sealed: false,
        productName: "Fury Sliver",
        setId: 1001,
        setCode: "TSP",
        productId: 14240,
        setName: "Time Spiral",
        productLineId: 1,
        productStatusId: 1,
        productLineName: "Magic",
        customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
        formattedAttributes: { Artist: "Paolo Parente" },
        skus: [{ sku: 50014240, condition: "Near Mint", variant: "Normal", language: "English" }],
        marketPrice: 1.23,
        lowestPrice: 1.01,
        lowestPriceWithShipping: 1.23,
        medianPrice: 1.5,
        listings: 25,
      },
    ],
    [
      96601,
      {
        productTypeName: "Sealed Products",
        rarityName: "Sealed",
        sealed: true,
        productName: "Time Spiral Booster Pack",
        setId: 1001,
        setCode: "TSP",
        productId: 96601,
        setName: "Time Spiral",
        productLineId: 1,
        productStatusId: 1,
        productLineName: "Magic",
        customAttributes: { number: "PACK", releaseDate: "2006-10-06", cardType: ["Sealed"] },
        formattedAttributes: {},
        skus: [{ sku: 50096601, condition: "Sealed", variant: "Sealed", language: "English" }],
        marketPrice: 12.34,
        lowestPrice: 10.01,
        lowestPriceWithShipping: 11.23,
        medianPrice: 12.5,
        listings: 25,
      },
    ],
  ]);

  return {
    listProductLines: async () => [
      {
        productLineId: 3,
        productLineName: "Pokemon",
        productLineUrlName: "pokemon",
        isDirect: true,
      },
      {
        productLineId: 1,
        productLineName: "Magic",
        productLineUrlName: "magic",
        isDirect: true,
      },
    ],
    listCatalogSetNames: async () => ({
      errors: [],
      results: [
        {
          setNameId: 1001,
          categoryId: 1,
          name: "Time Spiral",
          cleanSetName: "Time Spiral",
          urlName: "time-spiral",
          abbreviation: "TSP",
          releaseDate: "2006-10-06",
          isSupplemental: false,
          active: true,
        },
      ],
    }),
    searchProducts: async () => ({
      errors: [],
      results: [],
    }),
    listAllProducts: async () => [
      {
        productId: 14240,
        productName: "Fury Sliver",
        productLineId: 1,
        productLineName: "Magic",
        productTypeName: "Cards",
        setId: 1001,
        setName: "Time Spiral",
        setUrlName: "time-spiral",
        rarityName: "Uncommon",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
      },
      {
        productId: 96601,
        productName: "Time Spiral Booster Pack",
        productLineId: 1,
        productLineName: "Magic",
        productTypeName: "Sealed Products",
        setId: 1001,
        setName: "Time Spiral",
        setUrlName: "time-spiral",
        rarityName: "Sealed",
        sealed: true,
        productStatusId: 1,
        customAttributes: { number: "PACK", releaseDate: "2006-10-06", cardType: ["Sealed"] },
      },
      {
        productId: 610001,
        productName: "Eevee ex",
        productLineId: 3,
        productLineName: "Pokemon",
        productTypeName: "Cards",
        setId: 7001,
        setName: "Prismatic Evolutions",
        setUrlName: "prismatic-evolutions",
        rarityName: "Special Illustration Rare",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "131", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
      },
    ],
    getProductDetail: async ({ productId }) => {
      const detail = details.get(productId);
      if (!detail) {
        throw new Error(`Product ${productId} not found.`);
      }
      return detail;
    },
  };
}

function yugiohTcgplayerClient(): TcgplayerAutomationCatalogClient {
  const details = new Map([
    [
      721337,
      {
        productTypeName: "Cards",
        rarityName: "Ultra Rare",
        sealed: false,
        productName: "Blue-Eyes White Dragon",
        setId: 2001,
        setCode: "LOB",
        productId: 721337,
        setName: "Legend of Blue Eyes White Dragon",
        productLineId: 2,
        productStatusId: 1,
        productLineName: "Yu-Gi-Oh!",
        customAttributes: { number: "LOB-001", releaseDate: "2002-03-08", cardType: ["Monster"] },
        formattedAttributes: {},
        skus: [{ sku: 800721337, condition: "Near Mint", variant: "1st Edition", language: "English" }],
        marketPrice: 21.5,
        lowestPrice: 20.01,
        lowestPriceWithShipping: 20.99,
        medianPrice: 22,
        listings: 12,
      },
    ],
    [
      14240,
      {
        productTypeName: "Cards",
        rarityName: "Uncommon",
        sealed: false,
        productName: "Fury Sliver",
        setId: 1001,
        setCode: "TSP",
        productId: 14240,
        setName: "Time Spiral",
        productLineId: 1,
        productStatusId: 1,
        productLineName: "Magic",
        customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
        formattedAttributes: {},
        skus: [{ sku: 50014240, condition: "Near Mint", variant: "Normal", language: "English" }],
        marketPrice: 1.23,
        lowestPrice: 1.01,
        lowestPriceWithShipping: 1.23,
        medianPrice: 1.5,
        listings: 25,
      },
    ],
    [
      610001,
      {
        productTypeName: "Cards",
        rarityName: "Special Illustration Rare",
        sealed: false,
        productName: "Eevee ex",
        setId: 7001,
        setCode: "PRE",
        productId: 610001,
        setName: "Prismatic Evolutions",
        productLineId: 3,
        productStatusId: 1,
        productLineName: "Pokemon",
        customAttributes: { number: "131", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
        formattedAttributes: {},
        skus: [{ sku: 7001001, condition: "Near Mint", variant: "Holofoil", language: "English" }],
        marketPrice: 10,
        lowestPrice: 9,
        lowestPriceWithShipping: 9.5,
        medianPrice: 11,
        listings: 30,
      },
    ],
  ]);

  return {
    listProductLines: async () => [
      {
        productLineId: 3,
        productLineName: "Pokemon",
        productLineUrlName: "pokemon",
        isDirect: true,
      },
      {
        productLineId: 1,
        productLineName: "Magic",
        productLineUrlName: "magic",
        isDirect: true,
      },
      {
        productLineId: 2,
        productLineName: "Yu-Gi-Oh!",
        productLineUrlName: "yugioh",
        isDirect: true,
      },
      {
        productLineId: 20,
        productLineName: "YuGiOh",
        productLineUrlName: "yugioh",
        isDirect: true,
      },
      {
        productLineId: 21,
        productLineName: "Yugioh",
        productLineUrlName: "yugioh",
        isDirect: true,
      },
      {
        productLineId: 22,
        productLineName: "Yu-Gi-Oh",
        productLineUrlName: "yu-gi-oh",
        isDirect: true,
      },
      {
        productLineId: 23,
        productLineName: "yugioh",
        productLineUrlName: "yugioh",
        isDirect: true,
      },
    ],
    listCatalogSetNames: async () => ({
      errors: [],
      results: [
        {
          setNameId: 2001,
          categoryId: 2,
          name: "Legend of Blue Eyes White Dragon",
          cleanSetName: "Legend of Blue Eyes White Dragon",
          urlName: "legend-of-blue-eyes-white-dragon",
          abbreviation: "LOB",
          releaseDate: "2002-03-08",
          isSupplemental: false,
          active: true,
        },
      ],
    }),
    searchProducts: async () => ({
      errors: [],
      results: [],
    }),
    listAllProducts: async () => [
      {
        productId: 721337,
        productName: "Blue-Eyes White Dragon",
        productLineId: 2,
        productLineName: "Yu-Gi-Oh!",
        productTypeName: "Cards",
        setId: 2001,
        setName: "Legend of Blue Eyes White Dragon",
        setUrlName: "legend-of-blue-eyes-white-dragon",
        rarityName: "Ultra Rare",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "LOB-001", releaseDate: "2002-03-08", cardType: ["Monster"] },
      },
      {
        productId: 14240,
        productName: "Fury Sliver",
        productLineId: 1,
        productLineName: "Magic",
        productTypeName: "Cards",
        setId: 1001,
        setName: "Time Spiral",
        setUrlName: "time-spiral",
        rarityName: "Uncommon",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
      },
      {
        productId: 610001,
        productName: "Eevee ex",
        productLineId: 3,
        productLineName: "Pokemon",
        productTypeName: "Cards",
        setId: 7001,
        setName: "Prismatic Evolutions",
        setUrlName: "prismatic-evolutions",
        rarityName: "Special Illustration Rare",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "131", releaseDate: "2025-01-17", cardType: ["Pokemon"] },
      },
    ],
    getProductDetail: async ({ productId }) => {
      const detail = details.get(productId);
      if (!detail) {
        throw new Error(`Product ${productId} not found.`);
      }
      return detail;
    },
  };
}

function onePieceTcgplayerClient(): TcgplayerAutomationCatalogClient {
  const details = new Map([
    [
      987650,
      {
        productTypeName: "Cards",
        rarityName: "Leader",
        sealed: false,
        productName: "Monkey.D.Luffy",
        setId: 6801,
        setCode: "OP-01",
        productId: 987650,
        setName: "Romance Dawn",
        productLineId: 68,
        productStatusId: 1,
        productLineName: "One Piece Card Game",
        customAttributes: { number: "OP01-001", releaseDate: "2022-12-02", cardType: ["Leader"] },
        formattedAttributes: {},
        skus: [{ sku: 900987650, condition: "Near Mint", variant: "Normal", language: "English" }],
        marketPrice: 8.5,
        lowestPrice: 7.99,
        lowestPriceWithShipping: 8.49,
        medianPrice: 9,
        listings: 42,
      },
    ],
    [
      987660,
      {
        productTypeName: "Sealed Products",
        rarityName: "Sealed",
        sealed: true,
        productName: "Romance Dawn Booster Box",
        setId: 6801,
        setCode: "OP-01",
        productId: 987660,
        setName: "Romance Dawn",
        productLineId: 68,
        productStatusId: 1,
        productLineName: "One Piece Card Game",
        customAttributes: { number: "BOX", releaseDate: "2022-12-02", cardType: ["Sealed"] },
        formattedAttributes: {},
        skus: [{ sku: 900987660, condition: "Sealed", variant: "Sealed", language: "English" }],
        marketPrice: 120,
        lowestPrice: 110,
        lowestPriceWithShipping: 115,
        medianPrice: 125,
        listings: 14,
      },
    ],
    [
      14240,
      {
        productTypeName: "Cards",
        rarityName: "Uncommon",
        sealed: false,
        productName: "Fury Sliver",
        setId: 1001,
        setCode: "TSP",
        productId: 14240,
        setName: "Time Spiral",
        productLineId: 1,
        productStatusId: 1,
        productLineName: "Magic",
        customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
        formattedAttributes: {},
        skus: [{ sku: 50014240, condition: "Near Mint", variant: "Normal", language: "English" }],
        marketPrice: 1.23,
        lowestPrice: 1.01,
        lowestPriceWithShipping: 1.23,
        medianPrice: 1.5,
        listings: 25,
      },
    ],
  ]);

  return {
    listProductLines: async () => [
      {
        productLineId: 1,
        productLineName: "Magic",
        productLineUrlName: "magic",
        isDirect: true,
      },
      {
        productLineId: 68,
        productLineName: "One Piece Card Game",
        productLineUrlName: "one-piece-card-game",
        isDirect: true,
      },
    ],
    listCatalogSetNames: async () => ({
      errors: [],
      results: [
        {
          setNameId: 6801,
          categoryId: 68,
          name: "Romance Dawn",
          cleanSetName: "Romance Dawn",
          urlName: "romance-dawn",
          abbreviation: "OP-01",
          releaseDate: "2022-12-02",
          isSupplemental: false,
          active: true,
        },
      ],
    }),
    searchProducts: async () => ({
      errors: [],
      results: [],
    }),
    listAllProducts: async () => [
      {
        productId: 987650,
        productName: "Monkey.D.Luffy",
        productLineId: 68,
        productLineName: "One Piece Card Game",
        productTypeName: "Cards",
        setId: 6801,
        setName: "Romance Dawn",
        setUrlName: "romance-dawn",
        rarityName: "Leader",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "OP01-001", releaseDate: "2022-12-02", cardType: ["Leader"] },
      },
      {
        productId: 987660,
        productName: "Romance Dawn Booster Box",
        productLineId: 68,
        productLineName: "One Piece Card Game",
        productTypeName: "Sealed Products",
        setId: 6801,
        setName: "Romance Dawn",
        setUrlName: "romance-dawn",
        rarityName: "Sealed",
        sealed: true,
        productStatusId: 1,
        customAttributes: { number: "BOX", releaseDate: "2022-12-02", cardType: ["Sealed"] },
      },
      {
        productId: 14240,
        productName: "Fury Sliver",
        productLineId: 1,
        productLineName: "Magic",
        productTypeName: "Cards",
        setId: 1001,
        setName: "Time Spiral",
        setUrlName: "time-spiral",
        rarityName: "Uncommon",
        sealed: false,
        productStatusId: 1,
        customAttributes: { number: "157", releaseDate: "2006-10-06", cardType: ["Creature"] },
      },
    ],
    getProductDetail: async ({ productId }) => {
      const detail = details.get(productId);
      if (!detail) {
        throw new Error(`Product ${productId} not found.`);
      }
      return detail;
    },
  };
}

function tcgdexFetch(responses: Readonly<Record<string, unknown>>): typeof globalThis.fetch {
  return async (input) => {
    const response = responses[String(input)];
    return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
  };
}
