import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

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
  createMtgjsonProviderAdapter,
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
import { createSourceObservationProviderImportRuntime } from "../source-observation-provider-import-runtime";
import { createIntegrationJobClaimHandoffHarness } from "../seeding/runtime-test-harness";
import type { CatalogItemServices } from "../../../catalog-items/api/runtime";
import { listAcceptedProviderScopeMappingsByScopeRecord } from "../../../provider-scope-mapping/read-model/queries";
import type { ProviderScopeMappingRow } from "../../../provider-scope-mapping/read-model/queries";
import {
  catalogSyncAcceptedScopeMappingFromRow,
  previewCatalogSyncProviderParticipation,
} from "../providers/catalog-sync-scope-planner";

describe("MTGJSON coordinate compatibility and refusal", () => {
  const unitKeys = [MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY, MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY];

  it.each(unitKeys)("preserves explicit aliases and whole-set execution parity for %s", async (unitKey) => {
    const deniedFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("Live fetch denied.");
    });
    const adapter = createMtgjsonProviderAdapter({ fetch: deniedFetch });
    const fixtureAdapter = createMtgjsonValidationProviderAdapter();
    const {
      items: [option],
    } = await fixtureAdapter.listOptions({ unitKey, optionKind: "sets" });
    expect(option).toMatchObject({ value: "TSP", label: "Time Spiral" });
    const version = getActiveCatalogProviderIntegrationProfileVersion("mtgjson", {
      profileKey:
        unitKey === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY ? "mtg-set-reference-data" : "mtg-card-reference-data",
    })!;
    const harness = createIntegrationJobClaimHandoffHarness();
    const unused = vi.fn(async () => {
      throw new Error("Import side effects denied.");
    });
    const runtime = createSourceObservationProviderImportRuntime({
      deps: harness.deps,
      items: {} as CatalogItemServices,
      referenceData: harness.referenceData,
      aliasCandidateSink: unused,
      commandHandler: unused,
      providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
      mergeCandidates: {
        persistCatalogMergeCandidatesFromObservations: unused,
        sourceObservationRecordToCandidateRow: () => {
          throw new Error("Import side effects denied.");
        },
      },
    });
    const [target] = await runtime.resolveProviderAdapterImportTargets(
      {
        provider: "mtgjson",
        ingestionUnitKey: unitKey,
        setName: option!.value,
      },
      version,
    );
    const executionPlan = await adapter.planImport({ unitKey, scopeKey: target!.scopeKey, values: target!.values });
    const expectedKey =
      unitKey === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY ? "mtgjson:set:TSP" : "mtgjson:cards:set:TSP";
    const executionPayloads = await collectPayloads(fixtureAdapter.fetchPayloads(executionPlan));
    expect(executionPayloads).toHaveLength(1);
    expect(executionPayloads[0]?.payload.kind).toBe(
      unitKey === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY ? "set-reference" : "single-card",
    );

    const coordinateInputs: Readonly<Record<string, string>>[] = [
      { setCode: "TSP" },
      { code: "TSP" },
      { setName: option!.value },
      { setCode: " TSP ", code: "NOT_THE_CODE", setName: "Not the option value" },
      { code: " TSP ", setName: "Not the option value" },
    ];
    for (const values of coordinateInputs) {
      const plan = await adapter.planImport({ unitKey, scopeKey: "set-name", values });
      expect(plan).toMatchObject({ planKey: expectedKey, scope: { scopeKey: "set", values: { setCode: "TSP" } } });
      expect(plan.scope.values.cardName).toBeUndefined();
      expect(plan.scope.values.uuid).toBeUndefined();
      expect(await collectPayloads(fixtureAdapter.fetchPayloads(plan))).toEqual(executionPayloads);
    }
    const singleCardPlan = await adapter.planImport({
      unitKey,
      scopeKey: "single-card",
      values: {
        setCode: "TSP",
        code: "OTHER",
        setName: "Other",
        cardName: "Fury Sliver",
        collectorNumber: "157",
      },
    });
    expect(singleCardPlan.planKey).toBe(
      unitKey === MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY ? "mtgjson:set:TSP" : "mtgjson:card:TSP:Fury Sliver:157",
    );
    expect(deniedFetch).not.toHaveBeenCalled();
    expect(unused).not.toHaveBeenCalled();
  });

  it.each(unitKeys)("refuses absent and blank coordinates without alias fallthrough for %s", async (unitKey) => {
    const deniedFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("Live fetch denied.");
    });
    const adapter = createMtgjsonProviderAdapter({ fetch: deniedFetch });
    const coordinateInputs: Readonly<Record<string, string>>[] = [
      {},
      { setId: "TSP" },
      { name: "Time Spiral" },
      { setName: " " },
      { setCode: "" },
      { code: " " },
      { setCode: " ", code: "TSP", setName: "TSP" },
      { code: "", setName: "TSP" },
    ];
    for (const values of coordinateInputs) {
      await expect(adapter.planImport({ unitKey, scopeKey: "set-name", values })).rejects.toThrow(
        "MTGJSON import planning requires setCode.",
      );
    }
    expect(deniedFetch).not.toHaveBeenCalled();
  });

  it.each(["absent", "rejected", "revoked", "proposed"])(
    "does not substitute the canonical TSP id for a %s mapping",
    async (status) => {
      const unitKey = MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY;
      const db: PgQueryable = {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          expect(sql).toContain("review_status IN ('accepted', 'auto-accepted')");
          expect(values).toEqual(["TSP"]);
          const storedRows = status === "absent" ? [] : [{ review_status: status, set_name: "TSP" }];
          return {
            rows: storedRows.filter((row) => ["accepted", "auto-accepted"].includes(row.review_status)) as Row[],
          };
        },
      };
      const mappings: readonly ProviderScopeMappingRow[] = await listAcceptedProviderScopeMappingsByScopeRecord(
        db,
        "TSP",
      );
      const deniedFetch = vi.fn<typeof fetch>(async () => {
        throw new Error("Live fetch denied.");
      });
      const adapter = createMtgjsonProviderAdapter({ fetch: deniedFetch });
      const planImport = vi.spyOn(adapter, "planImport");
      const version = getActiveCatalogProviderIntegrationProfileVersion("mtgjson", {
        profileKey: "mtg-set-reference-data",
      })!;
      const preview = await previewCatalogSyncProviderParticipation({
        scope: {
          scopeVersion: "catalog-sync-scope-v2",
          productDomain: "magic",
          reference: { kind: "set", scopeRecordId: "TSP" },
        },
        acceptedScopeMappings: mappings.map(catalogSyncAcceptedScopeMappingFromRow),
        providerProfileVersions: [version],
        providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
      });
      expect(preview.units).toEqual([
        expect.objectContaining({
          unitKey,
          childExecutionScope: null,
          eligibility: "ineligible",
          blockers: [expect.objectContaining({ code: "provider-scope-mapping-missing" })],
        }),
      ]);
      expect(planImport).not.toHaveBeenCalled();
      expect(deniedFetch).not.toHaveBeenCalled();
    },
  );
});

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

function tcgdexFetch(responses: Readonly<Record<string, unknown>>): typeof globalThis.fetch {
  return async (input) => {
    const response = responses[String(input)];
    return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
  };
}
