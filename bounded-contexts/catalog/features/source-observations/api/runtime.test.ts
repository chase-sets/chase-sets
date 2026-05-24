import { describe, expect, it } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRecordCommand, ReferenceTypeCommand } from "../../reference-data/domain/domain";
import type { SourceObservationNormalized } from "../domain/domain";
import { createSourceObservationRuntime, ensurePokemonReferenceHierarchy } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

type ReferenceTypeRow = {
  reference_type_id: string;
  key: string;
};

type ReferenceRecordRow = {
  reference_record_id: string;
  type_key: string;
  key: string;
  attributes: Readonly<Record<string, JsonValue>>;
};

describe("source observation runtime", () => {
  it("preloads and reuses TCGdex reference records by provider attributes", async () => {
    const harness = createReferencePreloadHarness();

    const firstExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
      normalized: pokemonObservation({
        expansionName: "Ascended Heroes",
        seriesName: "Mega Evolution",
      }),
      context,
    });
    const translatedExpansionReferenceId = await ensurePokemonReferenceHierarchy({
      deps: harness.deps,
      referenceData: harness.referenceData,
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
          en: "Furret 136/217",
        },
      },
      subtitle: {
        values: {
          en: "Ascended Heroes Updated • Parallel Set - Reverse Foil • Uncommon",
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

  it("reapplies promoted observations by refreshing the linked Catalog Item without creating a replacement", async () => {
    const harness = createChangedObservationRefreshHarness({ status: "promoted" });
    const services = createSourceObservationRuntime(harness.deps, harness.items, harness.referenceData);

    const result = await services.reapplyObservations({
      observationIds: ["obs_changed"],
      context,
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
    expect(harness.appendedSourceEvents).toEqual([]);
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

  it("uses the Expansion printed-card-count attribute as the displayed card number denominator", async () => {
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
          en: "Abra 43/102",
        },
      },
      subtitle: {
        values: {
          en: "Base Set • Parallel Set - Reverse Foil • Common",
        },
      },
    });
  });

  it("omits the card count denominator when the Expansion printed-card-count attribute is null", async () => {
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
          en: "Rowlet SM01",
        },
      },
      subtitle: {
        values: {
          en: "Sun & Moon Promos • Promo",
        },
      },
    });
  });

  it("uses the bare card number when no official or configured card count is available", async () => {
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
          en: "Pikachu XY01",
        },
      },
      subtitle: {
        values: {
          en: "XY Promos • Promo",
        },
      },
    });
  });
});

function pokemonObservation(input: {
  expansionName: string;
  seriesName: string;
  cardNumber?: string;
  expansionCardCount?: number | null;
  name?: string;
  rarity?: string | null;
  cardVariantKey?: string;
  cardVariantLabel?: string;
  cardVariantSourceKey?: string | null;
  parallelSet?: boolean;
}): SourceObservationNormalized {
  return {
    kind: "pokemon-card",
    tcg: "pokemon",
    languageCode: "en",
    name: input.name ?? "Furret",
    cardNumber: input.cardNumber ?? "136",
    setId: "me02.5",
    setName: input.expansionName,
    expansionId: "me02.5",
    expansionName: input.expansionName,
    expansionAbbreviation: "MEH",
    expansionCardCount: input.expansionCardCount === undefined ? 217 : input.expansionCardCount,
    expansionParallelSetCardCount: 78,
    seriesId: "me",
    seriesName: input.seriesName,
    rarity: input.rarity ?? "Uncommon",
    illustrator: "tetsuya koizumi",
    releaseDate: "2026-05-18",
    releaseYear: 2026,
    category: "Pokemon",
    imageBaseUrl: null,
    imageUrls: [],
    productAssetSet: null,
    parallelSet: input.parallelSet ?? true,
    cardVariantKey: input.cardVariantKey ?? "reverse-holo",
    cardVariantLabel: input.cardVariantLabel ?? "Parallel Set - Reverse Foil",
    cardVariantSourceKey: input.cardVariantSourceKey ?? "reverse",
    cardVariantIsPrimaryImage: false,
    imageDisclaimer:
      "TCGDex provides one image for this card number. This Catalog Item represents the Parallel Set - Reverse Foil variant, so the image may not show the exact foil or pattern.",
    variants: {},
  };
}

function createReferencePreloadHarness() {
  const referenceTypes = new Map<string, ReferenceTypeRow>();
  const referenceRecords = new Map<string, ReferenceRecordRow>();
  const referenceRecordCreateCommands: Extract<ReferenceRecordCommand, { type: "CreateReferenceRecord" }>[] = [];
  let projectorRuns = 0;

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_reference_types")) {
          const referenceTypeId = String(values[0]);
          const row = referenceTypes.get(referenceTypeId);
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("WHERE type_key = $1 AND key = $2")) {
          const typeKey = String(values[0]);
          const key = String(values[1]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.key === key,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("attributes ->> $2")) {
          const typeKey = String(values[0]);
          const attributeKey = String(values[1]);
          const attributeValue = String(values[2]);
          const row = Array.from(referenceRecords.values()).find(
            (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
          );
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
  } as unknown as CatalogRuntimeDeps;

  const referenceData = {
    referenceTypeCommandHandler: async (input: { command: ReferenceTypeCommand }) => {
      if (input.command.type === "CreateReferenceType") {
        referenceTypes.set(input.command.referenceTypeId, {
          reference_type_id: input.command.referenceTypeId,
          key: input.command.key,
        });
      }
    },
    referenceRecordCommandHandler: async (input: { command: ReferenceRecordCommand }) => {
      if (input.command.type === "CreateReferenceRecord") {
        referenceRecordCreateCommands.push(input.command);
        referenceRecords.set(input.command.referenceRecordId, {
          reference_record_id: input.command.referenceRecordId,
          type_key: input.command.typeKey,
          key: input.command.key,
          attributes: input.command.attributes ?? {},
        });
      }
    },
    projectors: [
      {
        runOnce: async () => {
          projectorRuns += 1;
          return { processed: 0 };
        },
      },
    ],
  } as unknown as ReferenceDataServices;

  return {
    deps,
    referenceData,
    referenceRecordCreateCommands,
    projectorRuns: () => projectorRuns,
    referenceRecordsByProviderAttribute(typeKey: string, attributeKey: string, attributeValue: string) {
      return Array.from(referenceRecords.values()).filter(
        (record) => record.type_key === typeKey && record.attributes[attributeKey] === attributeValue,
      );
    },
  };
}

function createChangedObservationRefreshHarness(
  input: {
    normalized?: SourceObservationNormalized;
    expansionAttributes?: Readonly<Record<string, JsonValue>>;
    status?: string;
    promotedCatalogItemId?: string | null;
    reusableCatalogItemId?: string | null;
  } = {},
) {
  const itemCommands: Array<{ streamId: string; command: { type: string } & Record<string, unknown> }> = [];
  const appendedSourceEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let itemProjectorRuns = 0;
  let referenceProjectorRuns = 0;
  const normalized =
    input.normalized ??
    pokemonObservation({
      expansionName: "Ascended Heroes Updated",
      seriesName: "Mega Evolution",
    });
  const observationRow = {
    observation_id: "obs_changed",
    provider_key: "tcgdex",
    external_key: "me02.5-136:reverse-holo",
    source_url: "https://api.tcgdex.net/v2/en/cards/me02.5-136",
    language_code: "en",
    source_record_hash: "new-hash",
    source_updated_at: "2026-05-20T00:00:00.000Z",
    observed_at: "2026-05-20T00:00:00.000Z",
    normalized,
    source_payload: { id: "me02.5-136" },
    status: input.status ?? "changed",
    status_reason: null,
    promoted_catalog_item_id: input.promotedCatalogItemId === undefined ? "cat_existing" : input.promotedCatalogItemId,
    promoted_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
  };
  const streamId = "catalog.source-observation-obs_changed";
  const observationStatus = input.status ?? "changed";
  const sourceEvents = [
    storedEvent(1, streamId, "catalog.source-observation.recorded", {
      ...observationRow,
      observationId: observationRow.observation_id,
      providerKey: observationRow.provider_key,
      externalKey: observationRow.external_key,
      sourceUrl: observationRow.source_url,
      languageCode: observationRow.language_code,
      sourceRecordHash: observationStatus === "observed" ? observationRow.source_record_hash : "old-hash",
      sourceUpdatedAt: observationStatus === "observed" ? observationRow.source_updated_at : null,
      observedAt: observationStatus === "observed" ? observationRow.observed_at : "2026-05-19T00:00:00.000Z",
      normalized,
      sourcePayload: observationRow.source_payload,
    }),
    ...(observationStatus === "observed"
      ? []
      : [
          storedEvent(2, streamId, "catalog.source-observation.promoted", {
            catalogItemId: observationRow.promoted_catalog_item_id ?? "cat_existing",
            promotedAt: "2026-05-19T00:00:00.000Z",
          }),
        ]),
    ...(observationStatus === "changed"
      ? [
          storedEvent(3, streamId, "catalog.source-observation.changed", {
            observationId: observationRow.observation_id,
            providerKey: observationRow.provider_key,
            externalKey: observationRow.external_key,
            sourceUrl: observationRow.source_url,
            languageCode: observationRow.language_code,
            sourceRecordHash: observationRow.source_record_hash,
            sourceUpdatedAt: observationRow.source_updated_at,
            observedAt: observationRow.observed_at,
            normalized,
            sourcePayload: observationRow.source_payload,
          }),
        ]
      : []),
  ];

  const deps = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("FROM catalog_source_observations")) {
          return {
            rowCount: 1,
            rows: [observationRow] as T[],
          };
        }

        if (sql.includes("FROM catalog_external_product_references")) {
          const row = input.reusableCatalogItemId ? { catalog_item_id: input.reusableCatalogItemId } : null;
          return {
            rowCount: row ? 1 : 0,
            rows: (row ? [row] : []) as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_types")) {
          return {
            rowCount: 1,
            rows: [{ reference_type_id: String(values[0]) }] as T[],
          };
        }

        if (sql.includes("WHERE reference_record_id = $1")) {
          return {
            rowCount: 1,
            rows: [{ attributes: input.expansionAttributes ?? {} }] as T[],
          };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          return {
            rowCount: 1,
            rows: [{ reference_record_id: `ref_${String(values[1] ?? "existing")}` }] as T[],
          };
        }

        if (sql.includes("FROM catalog_blueprints")) {
          return { rowCount: 1, rows: [{ id: "bpr_pokemon" }] as T[] };
        }

        if (sql.includes("FROM catalog_categories")) {
          return { rowCount: 1, rows: [{ id: "cat_singles" }] as T[] };
        }

        if (sql.includes("FROM catalog_fields")) {
          return { rowCount: 1, rows: [{ id: `fld_${String(values[0])}` }] as T[] };
        }

        return { rowCount: 0, rows: [] as T[] };
      },
    },
    eventStore: {
      readStream: async () => sourceEvents,
      appendToStream: async (input: {
        events: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
      }) => {
        appendedSourceEvents.push(...input.events);
        return input.events.map((event, index) => storedEvent(4 + index, streamId, event.eventType, event.payload));
      },
      readAll: async () => [],
    },
    checkpointStore: {
      loadCheckpoint: async () => "0",
      saveCheckpoint: async () => undefined,
    },
  } as unknown as CatalogRuntimeDeps;

  const items = {
    commandHandler: async (input: { streamId: string; command: { type: string } & Record<string, unknown> }) => {
      itemCommands.push(input);
      return { version: itemCommands.length, state: { status: "draft" } };
    },
    projectors: [
      {
        runOnce: async () => {
          itemProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as unknown as CatalogItemServices;

  const referenceData = {
    referenceTypeCommandHandler: async () => ({ version: 1, state: {} }),
    referenceRecordCommandHandler: async () => ({ version: 1, state: {} }),
    projectors: [
      {
        runOnce: async () => {
          referenceProjectorRuns += 1;
          return { processed: 0, lastGlobalPosition: "0" };
        },
      },
    ],
  } as unknown as ReferenceDataServices;

  return {
    deps,
    items,
    referenceData,
    itemCommands,
    appendedSourceEvents,
    projectorRuns: () => itemProjectorRuns + referenceProjectorRuns,
  };
}

function storedEvent(streamVersion: number, streamId: string, eventType: string, payload: Record<string, unknown>) {
  return {
    eventId: `evt_${streamVersion}`,
    streamId,
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: context.tenantId,
    eventType,
    payload,
    metadata: {},
    occurredAt: "2026-05-20T00:00:00.000Z",
    recordedAt: "2026-05-20T00:00:00.000Z",
    performedByUserId: context.audit.performedByUserId,
    forAccountId: context.audit.forAccountId,
  };
}
