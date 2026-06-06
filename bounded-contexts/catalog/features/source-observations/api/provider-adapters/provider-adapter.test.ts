import { describe, expect, it } from "vitest";

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
import { ProviderAdapterRegistry } from "./registry";
import { createTcgdexProviderAdapter, TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "./tcgdex";
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
