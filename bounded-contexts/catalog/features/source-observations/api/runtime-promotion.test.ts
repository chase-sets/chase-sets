import { describe, expect, it } from "vitest";
import { createSourceObservationRuntime, ensurePokemonReferenceHierarchy } from "./runtime";
import { tcgdexPokemonTcgProviderProfile } from "./provider-integration-profiles";
import {
  context,
  createChangedObservationRefreshHarness,
  createReferencePreloadHarness,
  magicCardPrintObservation,
  pokemonObservation,
} from "./runtime-test-harness";

describe("source observation runtime: promotion and reapply", () => {
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
