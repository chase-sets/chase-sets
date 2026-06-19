import { describe, expect, it } from "vitest";
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
  createTcgplayerProviderAdapter,
  TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./tcgplayer";
import {
  getActiveCatalogProviderIntegrationProfileVersion,
  getCatalogProviderIntegrationProfileVersion,
} from "../provider-integration-profiles";
import type { TcgplayerAutomationCatalogClient } from "../tcgplayer-automation-catalog-client";
import { tcgplayerAutomationResponseFixtures } from "../tcgplayer-automation-response-fixtures.test-data";

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
      loadProfileVersions: async () => [requireTcgplayerProfileVersion()],
      client: tcgplayerClient(),
    });

    await expect(adapter.listIntegrationUnits()).resolves.toEqual([
      {
        unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "tcgplayer",
        productDomain: "pokemon",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
        displayName: "TCGplayer pokemon single-card",
        profileVersion: "2026.06.03",
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

  it("plans and fetches TCGplayer product detail payloads with typed provenance", async () => {
    const progress: unknown[] = [];
    const adapter = createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerProfileVersion()],
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
      loadProfileVersions: async () => [requireTcgplayerProfileVersion()],
      client: tcgplayerClient(),
    }).getTransportDiagnostics();
    const unconfigured = await createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerProfileVersion()],
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
      loadProfileVersions: async () => [requireTcgplayerProfileVersion()],
      client: tcgplayerClient(),
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    }).getCredentialReadiness();
    const unconfigured = await createTcgplayerProviderAdapter({
      loadProfileVersions: async () => [requireTcgplayerProfileVersion()],
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    }).getCredentialReadiness();

    expect(configured).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        requirement: "required",
        sourceKind: "operator-session",
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

  it("keeps MTGJSON and Scryfall validation out of core runtime, routes, Admin branches, and raw JSON paths", () => {
    const guardedFiles = [
      new URL("../runtime.ts", import.meta.url),
      new URL("../route.ts", import.meta.url),
      new URL("../route-helpers.ts", import.meta.url),
      new URL("../../ui/workbench-shell.tsx", import.meta.url),
      new URL("../../ui/integrations-surface-page.tsx", import.meta.url),
      new URL("../../ui/workbench-workspace-renderers.tsx", import.meta.url),
    ];

    for (const fileUrl of guardedFiles) {
      const file = fileURLToPath(fileUrl);
      const source = readFileSync(file, "utf8");

      expect(source, file).not.toMatch(/mtgjson/i);
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

function requireTcgplayerProfileVersion() {
  const version = getCatalogProviderIntegrationProfileVersion("tcgplayer");
  if (!version) {
    throw new Error("Expected TCGplayer profile version.");
  }
  return version;
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

function tcgdexFetch(responses: Readonly<Record<string, unknown>>): typeof globalThis.fetch {
  return async (input) => {
    const response = responses[String(input)];
    return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
  };
}
