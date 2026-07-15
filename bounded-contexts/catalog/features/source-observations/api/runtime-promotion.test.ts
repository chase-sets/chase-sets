import { describe, expect, it } from "vitest";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { SourceObservationYugiohSealedProductNormalized } from "../domain/domain";
import {
  createSourceObservationRuntime,
  ensurePokemonReferenceHierarchy,
  resolveYugiohSealedProductSetReference,
} from "./runtime";
import { tcgdexPokemonTcgProviderProfile } from "./provider-integration-profiles";
import {
  context,
  createChangedObservationRefreshHarness,
  createReferencePreloadHarness,
  lorcanaCardPrintObservation,
  lorcanaSetReferenceObservation,
  magicCardPrintObservation,
  magicSetReferenceObservation,
  magicSealedProductObservation,
  onePieceCardPrintObservation,
  onePieceSealedProductObservation,
  onePieceSetReferenceObservation,
  pokemonObservation,
} from "./runtime-test-harness";

describe("source observation runtime: promotion and reapply", () => {
  it("resolves exactly one YGOJSON boxed Set Reference Record and blocks missing or ambiguous evidence", async () => {
    const normalized = yugiohSealedProductObservation();
    const resolved = await resolveYugiohSealedProductSetReference({
      deps: yugiohReferenceResolutionDeps(["ref_yugioh_set_lob"]),
      normalized,
    });

    expect(resolved).toEqual({
      targetReferenceRecordId: "ref_yugioh_set_lob",
      referenceRecordIdsByTypeKey: { set: "ref_yugioh_set_lob" },
    });
    await expect(
      resolveYugiohSealedProductSetReference({
        deps: yugiohReferenceResolutionDeps([]),
        normalized: yugiohSealedProductObservation({ boxOfSetEvidence: [] }),
      }),
    ).rejects.toThrow("no Yu-Gi-Oh! Set Reference Record id was observed");
    await expect(
      resolveYugiohSealedProductSetReference({
        deps: yugiohReferenceResolutionDeps([]),
        normalized,
      }),
    ).rejects.toThrow("Set Reference Record '11111111-1111-4111-8111-111111111111' is missing");
    await expect(
      resolveYugiohSealedProductSetReference({
        deps: yugiohReferenceResolutionDeps([]),
        normalized: yugiohSealedProductObservation({ boxOfSetEvidence: ["set-a", "set-b"] }),
      }),
    ).rejects.toThrow("resolves ambiguously to 2 Yu-Gi-Oh! sets");
    await expect(
      resolveYugiohSealedProductSetReference({
        deps: yugiohReferenceResolutionDeps(["ref_yugioh_set_lob_a", "ref_yugioh_set_lob_b"]),
        normalized,
      }),
    ).rejects.toThrow("is ambiguous (2 matches)");
  });

  it("preloads and reuses TCGdex reference records by provider attributes", async () => {
    const harness = createReferencePreloadHarness();

    const firstExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
      profile: tcgdexPokemonTcgProviderProfile,
      normalized: pokemonObservation({
        expansionName: "Ascended Heroes",
        seriesName: "Mega Evolution",
      }),
      context,
    });
    const translatedExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
      profile: tcgdexPokemonTcgProviderProfile,
      normalized: pokemonObservation({
        expansionName: "Heros Ascendidos",
        seriesName: "Mega Evolucion",
      }),
      context,
    });

    expect(translatedExpansionReferenceId).toBe(firstExpansionReferenceId);
    expect(harness.referenceRecordsByProviderAttribute("series", "tcgdex-series-id", "me")).toHaveLength(1);
    expect(harness.referenceRecordsByProviderAttribute("expansion", "tcgdex-set-id", "me02.5")).toHaveLength(1);
    expect(
      harness.referenceRecordCreateCommands.filter(
        (command) => command.typeKey === "series" && command.attributes?.["tcgdex-series-id"] === "me",
      ),
    ).toHaveLength(1);
    expect(
      harness.referenceRecordCreateCommands.filter(
        (command) => command.typeKey === "expansion" && command.attributes?.["tcgdex-set-id"] === "me02.5",
      ),
    ).toHaveLength(1);
    expect(harness.projectorRuns()).toBe(0);
  });

  it("provisions TCGdex references for localized expansion names", async () => {
    const harness = createReferencePreloadHarness();

    const expansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
      profile: tcgdexPokemonTcgProviderProfile,
      normalized: {
        ...pokemonObservation({
          expansionName: "超電ブレイカー",
          seriesName: "Scarlet & Violet",
        }),
        languageCode: "ja",
        setId: "SV8",
        expansionId: "SV8",
        seriesId: "SV",
      },
      context,
    });

    expect(expansionReferenceId).toBe("ref_tcgdex_expansion_sv8");
    expect(harness.referenceRecordCreateCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          typeKey: "expansion",
          key: "sv8",
          name: expect.objectContaining({ values: { en: "超電ブレイカー" } }),
          attributes: expect.objectContaining({ "tcgdex-set-id": "SV8" }),
        }),
      ]),
    );
  });

  it("promotes changed observations by refreshing the linked Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness();
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Furret",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "LinkExternalProductReference",
          providerKey: "tcgdex",
          externalKey: "en:me02.5-136:reverse-holo",
        }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing",
        }),
      }),
    );
    expect(harness.projectorRuns()).toBe(0);
  });

  it("promotes observed observations by refreshing an existing Catalog Item linked to the same source", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      reusableCatalogItemId: "cat_existing_source",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing_source",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing_source",
        }),
      }),
    );
  });

  it("promotes observed observations by refreshing an existing Catalog Item linked to the same TCGplayer Product ID", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      reusableExternalCatalogItemIds: ["cat_existing_tcgplayer_product"],
      normalized: {
        ...pokemonObservation({
          expansionName: "Prismatic Evolutions",
          seriesName: "Scarlet & Violet",
        }),
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing_tcgplayer_product",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
      "LinkExternalCatalogItemReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        streamId: "catalog.item-cat_existing_tcgplayer_product",
        command: expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:610001",
        }),
      }),
    );
  });

  it("blocks future provider observations through the same TCGplayer Product ID reference instead of using another provider's compatible profile", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scryfall",
      status: "observed",
      promotedCatalogItemId: null,
      reusableExternalCatalogItemIds: ["cat_existing_scryfall_tcgplayer"],
      normalized: {
        ...pokemonObservation({
          expansionName: "Prismatic Evolutions",
          seriesName: "Scarlet & Violet",
        }),
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Provider 'scryfall' does not support Catalog Item promotion.");
    expect(harness.itemCommands).toEqual([]);
  });

  it("blocks promotion when external Catalog Item references match multiple Catalog Items", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      reusableExternalCatalogItemIds: ["cat_existing_a", "cat_existing_b"],
      normalized: {
        ...pokemonObservation({
          expansionName: "Prismatic Evolutions",
          seriesName: "Scarlet & Violet",
        }),
        externalCatalogItemReferences: [
          { providerKey: "tcgplayer", externalKey: "product:610001" },
          { providerKey: "cardmarket", externalKey: "product:700001" },
        ],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Multiple Catalog Items match this Source Observation's external catalog item references.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("promotes observed observations by refreshing one deterministic Catalog Item match", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      deterministicCatalogItemIds: ["cat_existing_deterministic"],
      normalized: pokemonObservation({
        expansionName: "Prismatic Evolutions",
        seriesName: "Scarlet & Violet",
        cardNumber: "131",
        name: "Eevee ex",
        cardVariantLabel: "Standard Set Foil",
        cardVariantKey: "holofoil",
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing_deterministic",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
  });

  it("blocks promotion when deterministic card evidence matches multiple Catalog Items", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      deterministicCatalogItemIds: ["cat_existing_a", "cat_existing_b"],
      normalized: pokemonObservation({
        expansionName: "Prismatic Evolutions",
        seriesName: "Scarlet & Violet",
        cardNumber: "131",
        name: "Eevee ex",
        cardVariantLabel: "Standard Set Foil",
        cardVariantKey: "holofoil",
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Multiple Catalog Items match this Source Observation's deterministic card evidence.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("promotes Magic card-print observations by refreshing one deterministic Catalog Item match", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceUrl: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceProfileKey: "mtg-card-print-reference-data",
      sourceProfileVersion: "2026.06.19",
      sourceMappingFingerprint: "fingerprint:scryfall:2026.06.19",
      status: "observed",
      promotedCatalogItemId: null,
      deterministicCatalogItemIds: ["cat_existing_magic_print"],
      normalized: magicCardPrintObservation({ externalCatalogItemReferences: [] }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing_magic_print",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        streamId: "catalog.item-cat_existing_magic_print",
        command: expect.objectContaining({
          type: "LinkExternalProductReference",
          providerKey: "scryfall",
          externalKey: "en:card:0000579f-7b35-4ed3-b44c-db2a538066fe",
        }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing_magic_print",
          promotionProfileKey: "mtg-card-print-reference-data",
          promotionProfileVersion: "2026.06.19",
        }),
      }),
    );
  });

  it("blocks Magic promotion when deterministic identity evidence matches multiple Catalog Items", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceProfileKey: "mtg-card-print-reference-data",
      sourceProfileVersion: "2026.06.19",
      sourceMappingFingerprint: "fingerprint:scryfall:2026.06.19",
      status: "observed",
      promotedCatalogItemId: null,
      deterministicCatalogItemIds: ["cat_existing_magic_a", "cat_existing_magic_b"],
      normalized: magicCardPrintObservation({ externalCatalogItemReferences: [] }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Multiple Catalog Items match this Source Observation's deterministic Magic identity evidence.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("promotes MTGJSON Magic set-reference observations into Reference Records", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "mtgjson",
      externalKey: "set:TSP",
      sourceUrl: "https://mtgjson.com/api/v5/TSP.json",
      sourceProfileKey: "mtg-set-reference-data",
      sourceProfileVersion: "2026.06.19",
      sourceMappingFingerprint: "fingerprint:mtgjson:set:2026.06.19",
      status: "observed",
      promotedCatalogItemId: null,
      normalized: magicSetReferenceObservation(),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: null,
      referenceRecordId: "ref_tsp",
    });
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.reference-promoted",
        payload: expect.objectContaining({
          referenceRecordId: "ref_tsp",
          promotionProfileKey: "mtg-set-reference-data",
          promotionProfileVersion: "2026.06.19",
          promotionPlanFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("promotes Scrydex One Piece set-reference observations into Reference Records", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scrydex",
      externalKey: "set:op01",
      sourceUrl: "https://api.scrydex.example/onepiece/v1/expansions/op01",
      sourceProfileKey: "scrydex-one-piece-set-reference",
      sourceProfileVersion: "2026.06.22",
      sourceMappingFingerprint: "fingerprint:scrydex:one-piece-set:2026.06.22",
      status: "observed",
      promotedCatalogItemId: null,
      normalized: onePieceSetReferenceObservation(),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: null,
      referenceRecordId: "ref_op01",
    });
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.reference-promoted",
        payload: expect.objectContaining({
          referenceRecordId: "ref_op01",
          promotionProfileKey: "one-piece-set-reference-data",
          promotionProfileVersion: "2026.06.22",
        }),
      }),
    );
  });

  it("promotes LorcanaJSON set-reference observations into Reference Records", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "lorcanajson",
      externalKey: "set:TFC",
      sourceUrl: "https://lorcanajson.org/files/current/en/sets/setdata.TFC.json",
      sourceProfileKey: "lorcana-set-reference-data",
      sourceProfileVersion: "2026.06.23",
      sourceMappingFingerprint: "fingerprint:lorcanajson:lorcana-set:2026.06.23",
      status: "observed",
      promotedCatalogItemId: null,
      normalized: lorcanaSetReferenceObservation(),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: null,
      referenceRecordId: "ref_tfc",
    });
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.reference-promoted",
        payload: expect.objectContaining({
          referenceRecordId: "ref_tfc",
          promotionProfileKey: "lorcana-set-reference-data",
          promotionProfileVersion: "2026.06.23",
          promotionPlanFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("fails image-backed promotion before writing partial Catalog Item commands when asset storage is unavailable", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      normalized: {
        ...pokemonObservation({
          expansionName: "Mega Evolution",
          seriesName: "Mega Evolution",
        }),
        imageBaseUrl: "https://assets.tcgdex.example/me01-001",
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);
    const initialItemCommandCount = harness.itemCommands.length;

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Catalog asset storage is required to promote source observation image assets.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("fails current Lorcana image promotion before writing partial Catalog Item commands when asset storage is unavailable", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "lorcanajson",
      externalKey: "card:TFC:41",
      sourceUrl: "https://lorcanajson.org/files/current/en/sets/setdata.TFC.json",
      sourceProfileKey: "lorcana-card-reference-data",
      sourceProfileVersion: "2026.06.23",
      sourceMappingFingerprint: "fingerprint:lorcanajson:lorcana-card:2026.06.23",
      status: "observed",
      promotedCatalogItemId: null,
      normalized: lorcanaCardPrintObservation({
        imageUrls: ["https://images.lorcanajson.org/cards/en/1/041.webp"],
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).rejects.toThrow("Catalog asset storage is required to promote source observation image assets.");
    expect(harness.itemCommands).toEqual([]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("reuses a partially promoted TCGdex draft Catalog Item when retrying an observed Source Observation", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "observed",
      promotedCatalogItemId: null,
      partialCatalogItemId: "cat_partial",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_partial",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          catalogItemId: "cat_partial",
        }),
      }),
    );
  });

  it("repromotes promoted observations by resyncing the linked Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "promoted" });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result).toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a single promotion retry as successful when the observation was already promoted concurrently", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "changed",
      promotedCatalogItemId: "cat_existing",
      promotionCommandAlreadyApplied: { catalogItemId: "cat_existing" },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);
    const initialItemCommandCount = harness.itemCommands.length;

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).resolves.toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toContain("ReviseCatalogItemMetadata");
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a single promotion retry as successful when the observation is already promoted before processing", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      promotedCatalogItemId: "cat_existing",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await expect(
      services.promoteObservation({
        observationId: "obs_changed",
        context,
      }),
    ).resolves.toEqual({
      observationId: "obs_changed",
      catalogItemId: "cat_existing",
    });
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a promotion retry as successful when the observation was already promoted concurrently", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "changed",
      promotedCatalogItemId: "cat_existing",
      promotionCommandAlreadyApplied: { catalogItemId: "cat_existing" },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservations({
      observationIds: ["obs_changed"],
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      promoted: 1,
      skipped: 0,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "promoted",
          catalogItemId: "cat_existing",
          reason: null,
        },
      ],
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toContain("ReviseCatalogItemMetadata");
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("treats a bulk promotion retry as successful when the observation is already promoted before processing", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      promotedCatalogItemId: "cat_existing",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);
    const result = await services.promoteObservations({
      observationIds: ["obs_changed"],
      context,
    });

    expect(result).toMatchObject({
      requested: 1,
      promoted: 1,
      skipped: 0,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "promoted",
          catalogItemId: "cat_existing",
          reason: null,
        },
      ],
    });
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("reapplies promoted observations by refreshing the linked Catalog Item without creating a replacement", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "promoted" });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 1,
      skipped: 0,
      failed: 0,
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
    expect(harness.appendedSourceEvents).toEqual([
      expect.objectContaining({
        eventType: "catalog.source-observation.promotion-plan-recorded",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing",
          promotionProfileKey: "pokemon-tcg",
          promotionProfileVersion: "2026.06.03",
          promotionPlanFingerprint: expect.any(String),
        }),
      }),
    ]);
  });

  it("reapplies promoted Magic observations with the original source profile version", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceUrl: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceProfileKey: "mtg-card-print-reference-data",
      sourceProfileVersion: "2026.06.19",
      sourceMappingFingerprint: "fingerprint:scryfall:2026.06.19",
      status: "promoted",
      promotedCatalogItemId: "cat_existing_magic_print",
      normalized: magicCardPrintObservation({ externalCatalogItemReferences: [] }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 1,
      skipped: 0,
      failed: 0,
    });
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
    ]);
    expect(harness.appendedSourceEvents).toEqual([
      expect.objectContaining({
        eventType: "catalog.source-observation.promotion-plan-recorded",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing_magic_print",
          promotionProfileKey: "mtg-card-print-reference-data",
          promotionProfileVersion: "2026.06.19",
        }),
      }),
    ]);
  });

  it("reapplies promoted MTGJSON Magic set-reference observations without Catalog Item commands", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "mtgjson",
      externalKey: "set:TSP",
      sourceUrl: "https://mtgjson.com/api/v5/TSP.json",
      sourceProfileKey: "mtg-set-reference-data",
      sourceProfileVersion: "2026.06.19",
      sourceMappingFingerprint: "fingerprint:mtgjson:set:2026.06.19",
      status: "promoted",
      promotedCatalogItemId: null,
      promotedReferenceRecordId: "ref_tsp",
      normalized: magicSetReferenceObservation(),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const firstResult = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "current-active-profile",
    });
    const secondResult = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "current-active-profile",
    });

    expect(firstResult).toMatchObject({
      requested: 1,
      reapplied: 1,
      skipped: 0,
      failed: 0,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "reapplied",
          catalogItemId: null,
          referenceRecordId: "ref_tsp",
          reason: null,
        },
      ],
    });
    expect(secondResult).toEqual(firstResult);
    expect(harness.itemCommands).toEqual([]);
    const planEvents = harness.appendedSourceEvents.filter(
      (event) => event.eventType === "catalog.source-observation.reference-promotion-plan-recorded",
    );
    expect(planEvents).toHaveLength(2);
    expect(planEvents).toEqual([
      expect.objectContaining({
        eventType: "catalog.source-observation.reference-promotion-plan-recorded",
        payload: expect.objectContaining({
          referenceRecordId: "ref_tsp",
          promotionProfileKey: "mtg-set-reference-data",
          promotionProfileVersion: "2026.06.19",
          promotionPlanFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      }),
      expect.objectContaining({
        eventType: "catalog.source-observation.reference-promotion-plan-recorded",
        payload: expect.objectContaining({
          referenceRecordId: "ref_tsp",
          promotionProfileKey: "mtg-set-reference-data",
          promotionProfileVersion: "2026.06.19",
          promotionPlanFingerprint: planEvents[0]?.payload.promotionPlanFingerprint,
        }),
      }),
    ]);
  });

  it("promotes Magic sealed products with set fields and TCGplayer SKU selected options", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      sourceUrl: "https://mpapi.tcgplayer.invalid/catalog/product/96601",
      sourceProfileKey: "mtg-sealed-product-sku",
      sourceProfileVersion: "2026.06.19",
      sourceMappingFingerprint: "fingerprint:tcgplayer:mtg-sealed-product:2026.06.19",
      status: "observed",
      promotedCatalogItemId: null,
      normalized: magicSealedProductObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
        externalProductReferences: [
          {
            providerKey: "tcgplayer",
            externalKey: "sku:50096601",
            selectedOptions: [
              { dimensionId: "dim_product_form", optionId: "opt_unopened" },
              { dimensionId: "dim_language", optionId: "opt_english" },
            ],
          },
        ],
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result.catalogItemId).toMatch(/^cat_/);
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "AssignBlueprintToCatalogItem",
          blueprintId: "bpr_magic-sealed-product",
        }),
      }),
    );
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "AssignCatalogItemToCategory",
          categoryId: "cat_magic-booster-packs",
        }),
      }),
    );
    expect(harness.itemCommands.map((entry) => entry.command.type)).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "AssignCatalogItemToCategory",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
      "LinkExternalCatalogItemReference",
      "LinkExternalProductReference",
    ]);
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_set",
          value: { referenceId: "ref_time-spiral" },
        }),
      }),
    );
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "SetCatalogItemFieldValue",
          fieldId: "fld_pack-count",
          value: 1,
        }),
      }),
    );
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:96601",
        }),
      }),
    );
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: "sku:50096601",
          selectedOptions: [
            { dimensionId: "dim_product_form", optionId: "opt_unopened" },
            { dimensionId: "dim_language", optionId: "opt_english" },
          ],
        }),
      }),
    );
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: expect.stringMatching(/price|listing|inventory|seller/i),
        }),
      }),
    );
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          promotionProfileKey: "mtg-sealed-product-sku",
          promotionProfileVersion: "2026.06.19",
        }),
      }),
    );
  });

  it("promotes One Piece card prints with set fields and TCGplayer marketplace references", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scrydex",
      externalKey: "card:op01-001",
      sourceUrl: "https://api.scrydex.example/onepiece/v1/cards/op01-001",
      sourceProfileKey: "scrydex-one-piece-card-print",
      sourceProfileVersion: "2026.06.22",
      sourceMappingFingerprint: "fingerprint:scrydex:one-piece-card:2026.06.22",
      status: "observed",
      promotedCatalogItemId: null,
      normalized: onePieceCardPrintObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:555001" }],
        externalProductReferences: [
          {
            providerKey: "tcgplayer",
            externalKey: "sku:888001",
            selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
          },
        ],
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(result.observationId).toBe("obs_changed");
    expect(result.catalogItemId).toMatch(/^cat_/);
    expect(harness.itemCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.objectContaining({
            type: "AssignBlueprintToCatalogItem",
            blueprintId: "bpr_one-piece-card-print",
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "SetCatalogItemFieldValue",
            fieldId: "fld_set",
            value: { referenceId: "ref_op01" },
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "LinkExternalCatalogItemReference",
            providerKey: "tcgplayer",
            externalKey: "product:555001",
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "LinkExternalProductReference",
            providerKey: "tcgplayer",
            externalKey: "sku:888001",
            selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
          }),
        }),
      ]),
    );
  });

  it("promotes Lorcana card prints through the shared Catalog Item command pipeline", async () => {
    const originalFetch = globalThis.fetch;
    const storedAssetKeys: string[] = [];
    const harness = createChangedObservationRefreshHarness({
      providerKey: "lorcanajson",
      externalKey: "card:TFC:41",
      sourceUrl: "https://lorcanajson.org/files/current/en/sets/setdata.TFC.json",
      sourceProfileKey: "lorcana-card-reference-data",
      sourceProfileVersion: "2026.06.23",
      sourceMappingFingerprint: "fingerprint:lorcanajson:lorcana-card:2026.06.23",
      status: "observed",
      promotedCatalogItemId: null,
      normalized: lorcanaCardPrintObservation({
        imageUrls: ["https://images.lorcanajson.org/cards/en/1/041.webp"],
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
        externalProductReferences: [
          {
            providerKey: "lorcanajson",
            externalKey: "card:TFC:41",
            selectedOptions: [{ dimensionId: "dim_language", optionId: "opt_english" }],
          },
        ],
      }),
      assetStorage: {
        async putObject(input) {
          storedAssetKeys.push(input.key);
          return {
            key: input.key,
            publicUrl: `https://assets.chasesets.test/${input.key}`,
          };
        },
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);
    globalThis.fetch = (async () =>
      new Response(lorcanaCardSvg(), {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      })) as typeof globalThis.fetch;

    const result = await services
      .promoteObservation({
        observationId: "obs_changed",
        context,
      })
      .finally(() => {
        globalThis.fetch = originalFetch;
      });

    expect(result.catalogItemId).toMatch(/^cat_/);
    expect(harness.itemCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.objectContaining({
            type: "AssignBlueprintToCatalogItem",
            blueprintId: "bpr_lorcana-card-print",
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "AssignCatalogItemToCategory",
            categoryId: "cat_lorcana-card-prints",
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "SetCatalogItemFieldValue",
            fieldId: "fld_set",
            value: { referenceId: "ref_tfc" },
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "LinkExternalCatalogItemReference",
            providerKey: "tcgplayer",
            externalKey: "product:1005010",
          }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({
            type: "LinkExternalProductReference",
            providerKey: "lorcanajson",
            externalKey: "card:tfc:41",
            selectedOptions: [{ dimensionId: "dim_language", optionId: "opt_english" }],
          }),
        }),
      ]),
    );
    const setImageUrlsCommand = harness.itemCommands.find(
      (entry) => entry.command.type === "SetCatalogItemImageUrls",
    )?.command;
    expect(setImageUrlsCommand).toMatchObject({
      type: "SetCatalogItemImageUrls",
      imageUrls: [expect.stringMatching(/^https:\/\/assets\.chasesets\.test\/catalog\/items\/cat_/)],
    });
    expect(JSON.stringify(setImageUrlsCommand)).not.toContain("images.lorcanajson.org");
    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "SetCatalogItemProductAssetSets",
          productAssetSets: [
            expect.objectContaining({
              sourcePolicy: expect.objectContaining({
                sourceProviderKey: "lorcanajson",
                sourceUrlHost: "images.lorcanajson.org",
                sourceUrlHash: expect.stringMatching(/^[a-f0-9]{64}$/),
              }),
            }),
          ],
        }),
      }),
    );
    expect(JSON.stringify(harness.itemCommands)).not.toContain("https://images.lorcanajson.org/cards/en/1/041.webp");
    expect(storedAssetKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/source-"),
        expect.stringContaining("/thumbnail-"),
        expect.stringContaining("/catalog-detail-"),
      ]),
    );
    expect(harness.itemCommands.map((entry) => entry.command.type)).not.toContain("SetCatalogItemPrice");
    expect(harness.appendedSourceEvents).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.source-observation.promoted",
        payload: expect.objectContaining({
          promotionProfileKey: "lorcana-card-reference-data",
          promotionProfileVersion: "2026.06.23",
        }),
      }),
    );
  });

  it("reapplies promoted One Piece sealed products without replacing the Catalog Item or SKU options", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "scrydex",
      externalKey: "sealed:op01-booster-box",
      sourceProfileKey: "scrydex-one-piece-sealed-product",
      sourceProfileVersion: "2026.06.22",
      sourceMappingFingerprint: "fingerprint:scrydex:one-piece-sealed:2026.06.22",
      status: "promoted",
      promotedCatalogItemId: "cat_existing_one_piece_sealed",
      normalized: onePieceSealedProductObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:555900" }],
        externalProductReferences: [
          {
            providerKey: "tcgplayer",
            externalKey: "sku:888900",
            selectedOptions: [{ dimensionId: "dim_language", optionId: "opt_english" }],
          },
        ],
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const firstResult = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "current-active-profile",
    });

    expect(firstResult).toMatchObject({
      requested: 1,
      reapplied: 1,
      failed: 0,
      outcomes: [{ observationId: "obs_changed", status: "reapplied", catalogItemId: "cat_existing_one_piece_sealed" }],
    });
    expect(harness.itemCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          streamId: "catalog.item-cat_existing_one_piece_sealed",
          command: expect.objectContaining({
            type: "ReviseCatalogItemMetadata",
          }),
        }),
        expect.objectContaining({
          streamId: "catalog.item-cat_existing_one_piece_sealed",
          command: expect.objectContaining({
            type: "LinkExternalProductReference",
            providerKey: "tcgplayer",
            externalKey: "sku:888900",
            selectedOptions: [{ dimensionId: "dim_language", optionId: "opt_english" }],
          }),
        }),
      ]),
    );
    expect(harness.itemCommands).not.toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: "CreateCatalogItem" }),
      }),
    );
  });

  it("reapplies promoted Lorcana card prints without replacing the Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "lorcanajson",
      externalKey: "card:TFC:41",
      sourceUrl: "https://lorcanajson.org/files/current/en/sets/setdata.TFC.json",
      sourceProfileKey: "lorcana-card-reference-data",
      sourceProfileVersion: "2026.06.23",
      sourceMappingFingerprint: "fingerprint:lorcanajson:lorcana-card:2026.06.23",
      status: "promoted",
      promotedCatalogItemId: "cat_existing_lorcana_card",
      normalized: lorcanaCardPrintObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005010" }],
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "current-active-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 1,
      failed: 0,
      outcomes: [{ observationId: "obs_changed", status: "reapplied", catalogItemId: "cat_existing_lorcana_card" }],
    });
    expect(harness.itemCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          streamId: "catalog.item-cat_existing_lorcana_card",
          command: expect.objectContaining({
            type: "ReviseCatalogItemMetadata",
          }),
        }),
        expect.objectContaining({
          streamId: "catalog.item-cat_existing_lorcana_card",
          command: expect.objectContaining({
            type: "SetCatalogItemFieldValue",
            fieldId: "fld_set",
            value: { referenceId: "ref_tfc" },
          }),
        }),
      ]),
    );
    expect(harness.itemCommands.map((entry) => entry.command.type)).not.toContain("CreateCatalogItem");
    expect(harness.appendedSourceEvents).toEqual([
      expect.objectContaining({
        eventType: "catalog.source-observation.promotion-plan-recorded",
        payload: expect.objectContaining({
          catalogItemId: "cat_existing_lorcana_card",
          promotionProfileKey: "lorcana-card-reference-data",
          promotionProfileVersion: "2026.06.23",
        }),
      }),
    ]);
  });

  it("reapplies promoted Magic sealed products without replacing the Catalog Item or SKU options", async () => {
    const harness = createChangedObservationRefreshHarness({
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      sourceProfileKey: "mtg-sealed-product-sku",
      sourceProfileVersion: "2026.06.19",
      sourceMappingFingerprint: "fingerprint:tcgplayer:mtg-sealed-product:2026.06.19",
      status: "promoted",
      promotedCatalogItemId: "cat_existing_magic_sealed",
      normalized: magicSealedProductObservation({
        externalProductReferences: [
          {
            providerKey: "tcgplayer",
            externalKey: "sku:50096601",
            selectedOptions: [{ dimensionId: "dim_product_form", optionId: "opt_unopened" }],
          },
        ],
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const firstResult = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });
    const secondResult = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(firstResult).toMatchObject({
      requested: 1,
      reapplied: 1,
      skipped: 0,
      failed: 0,
    });
    expect(secondResult).toEqual(firstResult);
    expect(harness.itemCommands.map((entry) => entry.command.type)).not.toContain("CreateCatalogItem");
    const skuLinkCommands = harness.itemCommands.filter(
      (entry) => entry.command.type === "LinkExternalProductReference" && entry.command.externalKey === "sku:50096601",
    );
    expect(skuLinkCommands).toEqual([
      expect.objectContaining({
        streamId: "catalog.item-cat_existing_magic_sealed",
        command: expect.objectContaining({
          selectedOptions: [{ dimensionId: "dim_product_form", optionId: "opt_unopened" }],
        }),
      }),
      expect.objectContaining({
        streamId: "catalog.item-cat_existing_magic_sealed",
        command: expect.objectContaining({
          selectedOptions: [{ dimensionId: "dim_product_form", optionId: "opt_unopened" }],
        }),
      }),
    ]);
    const planEvents = harness.appendedSourceEvents.filter(
      (event) => event.eventType === "catalog.source-observation.promotion-plan-recorded",
    );
    expect(planEvents).toHaveLength(2);
    expect(planEvents).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          catalogItemId: "cat_existing_magic_sealed",
          promotionProfileKey: "mtg-sealed-product-sku",
          promotionProfileVersion: "2026.06.19",
          promotionPlanFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          catalogItemId: "cat_existing_magic_sealed",
          promotionProfileKey: "mtg-sealed-product-sku",
          promotionProfileVersion: "2026.06.19",
          promotionPlanFingerprint: planEvents[0]?.payload.promotionPlanFingerprint,
        }),
      }),
    ]);
  });

  it("fails original-profile reapply for promoted observations with retired legacy profile metadata", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      sourceProfileVersion: "legacy",
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 0,
      skipped: 0,
      failed: 1,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "failed",
          reason:
            "Source Observation obs_changed is missing original source profile version and cannot be reapplied with original-source-profile mode.",
        },
      ],
    });
    expect(harness.itemCommands).toEqual([]);
  });

  it("links TCGplayer product ids as Catalog Item references during promotion", async () => {
    const harness = createChangedObservationRefreshHarness({
      normalized: {
        ...pokemonObservation({
          expansionName: "Scarlet & Violet",
          seriesName: "Scarlet & Violet",
          name: "Sprigatito",
        }),
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:490001" }],
      },
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:490001",
        }),
      }),
    );
  });

  it("fails reapply for promoted observations missing their linked Catalog Item", async () => {
    const harness = createChangedObservationRefreshHarness({
      status: "promoted",
      promotedCatalogItemId: null,
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
      reapplyProfileMode: "original-source-profile",
    });

    expect(result).toMatchObject({
      requested: 1,
      reapplied: 0,
      failed: 1,
      outcomes: [
        {
          observationId: "obs_changed",
          status: "failed",
          reason: "Promoted source observation is missing its Catalog Item.",
        },
      ],
    });
    expect(harness.itemCommands).toEqual([]);
  });

  it("keeps promoted metadata as fallback when templates own display card numbering", async () => {
    const harness = createChangedObservationRefreshHarness({
      expansionAttributes: {
        "printed-card-count": 102,
      },
      normalized: pokemonObservation({
        cardNumber: "43",
        expansionCardCount: 110,
        expansionName: "Base Set",
        name: "Abra",
        rarity: "Common",
        seriesName: "Base",
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Abra",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
  });

  it("does not special-case promo metadata when templates own display subtitles", async () => {
    const harness = createChangedObservationRefreshHarness({
      expansionAttributes: {
        "printed-card-count": null,
      },
      normalized: pokemonObservation({
        cardNumber: "SM01",
        expansionCardCount: 200,
        expansionName: "Sun & Moon Promos",
        name: "Rowlet",
        rarity: "Promo",
        seriesName: "Sun & Moon",
        cardVariantKey: "standard",
        cardVariantLabel: "Standard Set",
        cardVariantSourceKey: "normal",
        parallelSet: false,
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Rowlet",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
  });

  it("uses the source name as fallback metadata without hard-coded card-number formatting", async () => {
    const harness = createChangedObservationRefreshHarness({
      normalized: pokemonObservation({
        cardNumber: "XY01",
        expansionCardCount: null,
        expansionName: "XY Promos",
        name: "Pikachu",
        rarity: "Promo",
        seriesName: "XY",
        cardVariantKey: "standard",
        cardVariantLabel: "Standard Set",
        cardVariantSourceKey: "normal",
        parallelSet: false,
      }),
    });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    await services.promoteObservation({
      observationId: "obs_changed",
      context,
    });

    expect(harness.itemCommands[0]?.command).toMatchObject({
      type: "ReviseCatalogItemMetadata",
      title: {
        values: {
          en: "Pikachu",
        },
      },
      subtitle: {
        values: {
          en: "",
        },
      },
    });
  });
});

function lorcanaCardSvg(): string {
  return `
    <svg width="120" height="168" viewBox="0 0 120 168" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="120" height="168" rx="8" ry="8" fill="rgb(78, 52, 121)" />
      <rect x="10" y="12" width="100" height="72" rx="4" ry="4" fill="rgb(244, 217, 119)" />
      <rect x="10" y="96" width="100" height="48" rx="4" ry="4" fill="rgb(240, 240, 246)" />
    </svg>
  `;
}

function yugiohSealedProductObservation(
  overrides: Partial<SourceObservationYugiohSealedProductNormalized> = {},
): SourceObservationYugiohSealedProductNormalized {
  return {
    kind: "yugioh-sealed-product",
    tcg: "yugioh",
    languageCode: "en",
    name: "Legend of Blue Eyes White Dragon Booster Box",
    setCode: null,
    setName: null,
    expansionName: null,
    cardNumber: null,
    sealedProductForm: "booster-box",
    releaseDate: "2002-03-08",
    productLineName: "Yu-Gi-Oh!",
    barcode: null,
    imageUrls: [],
    boxOfSetEvidence: ["11111111-1111-4111-8111-111111111111"],
    ...overrides,
  };
}

function yugiohReferenceResolutionDeps(referenceRecordIds: readonly string[]): CatalogRuntimeDeps {
  return {
    db: {
      query: async <T>() => ({
        rowCount: referenceRecordIds.length,
        rows: referenceRecordIds.map((referenceRecordId) => ({ reference_record_id: referenceRecordId })) as T[],
      }),
    },
  } as object as CatalogRuntimeDeps;
}
