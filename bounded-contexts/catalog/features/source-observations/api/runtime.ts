import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { catalogSeedIds } from "../../../support/seed-support/ids";
import type {
  CatalogItemId,
  BlueprintId,
  CategoryId,
  FieldId,
  ReferenceRecordId,
  ReferenceTypeId,
} from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRelationship } from "../../reference-data/domain/domain";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationCommand,
  type SourceObservationEvent,
  type SourceObservationNormalized,
  type SourceObservationState,
} from "../domain/domain";
import { buildSourceObservationProjectionHandlers } from "../read-model/projection";
import {
  getSourceObservationDetail,
  listSourceObservationIdsForPromotion,
  listSourceObservationIntegrationScopes,
  listSourceObservations,
  previewSourceObservationPromotionScope,
  type SourceObservationDetailRow,
  type SourceObservationFilterScope,
  type SourceObservationIntegrationScopeRow,
  type SourceObservationPromotionPreview,
} from "../read-model/queries";
import { fetchTcgdexSetObservations, type TcgdexSetImportResult } from "./tcgdex-client";

export type BulkSourceObservationPromotionOutcome = Readonly<{
  observationId: string;
  status: "promoted" | "skipped" | "failed";
  catalogItemId: CatalogItemId | null;
  reason: string | null;
}>;

export type BulkSourceObservationPromotionResult = Readonly<{
  requested: number;
  promoted: number;
  skipped: number;
  failed: number;
  outcomes: readonly BulkSourceObservationPromotionOutcome[];
}>;

export type SourceObservationServices = Readonly<{
  commandHandler: CommandHandler<
    SourceObservationCommand,
    SourceObservationState,
    SourceObservationEvent
  >;
  importTcgdexSet: (input: {
    languageCode: string;
    setId: string;
    context: EventStoreContext;
  }) => Promise<TcgdexSetImportResult>;
  promoteObservation: (input: {
    observationId: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; catalogItemId: CatalogItemId }>;
  promoteObservations: (input: {
    observationIds: readonly string[];
    context: EventStoreContext;
  }) => Promise<BulkSourceObservationPromotionResult>;
  previewPromoteObservationScope: (input: {
    scope: SourceObservationFilterScope;
  }) => Promise<SourceObservationPromotionPreview>;
  promoteObservationScope: (input: {
    scope: SourceObservationFilterScope;
    context: EventStoreContext;
  }) => Promise<BulkSourceObservationPromotionResult>;
  rejectObservation: (input: {
    observationId: string;
    reason: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; status: "rejected" }>;
  listSourceObservations: (
    params?: Parameters<typeof listSourceObservations>[1],
  ) => ReturnType<typeof listSourceObservations>;
  listIntegrationScopes: (params?: {
    provider?: string;
    language?: string;
    setId?: string;
  }) => Promise<readonly SourceObservationIntegrationScopeRow[]>;
  getSourceObservationDetail: (
    observationId: string,
  ) => ReturnType<typeof getSourceObservationDetail>;
  projectors: readonly Projector[];
}>;

export function createSourceObservationRuntime(
  deps: CatalogRuntimeDeps,
  items: CatalogItemServices,
  referenceData: ReferenceDataServices,
): SourceObservationServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
      initialState: () => initialSourceObservationState,
      evolve: evolveSourceObservation,
    }),
    evolve: evolveSourceObservation,
    decide: decideSourceObservation,
  });
  const projectors = [
    createProjector({
      projectorName: "catalog-source-observation-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: buildSourceObservationProjectionHandlers(deps.db),
    }),
  ];

  async function recordObservation(
    observation: Awaited<ReturnType<typeof fetchTcgdexSetObservations>>[number],
    context: EventStoreContext,
  ) {
    await commandHandler({
      streamId: sourceObservationStreamId(observation.observationId),
      command: {
        type: "RecordSourceObservation",
        ...observation,
      },
      context,
    });
  }

  async function promoteObservationFromRow(input: {
    observation: SourceObservationDetailRow;
    context: EventStoreContext;
  }): Promise<{ observationId: string; catalogItemId: CatalogItemId }> {
    const catalogItemId = createId("cat") as CatalogItemId;
    await createCatalogDraftFromObservation({
      items,
      referenceData,
      deps,
      catalogItemId,
      normalized: input.observation.normalized,
      providerKey: input.observation.provider_key,
      externalKey: input.observation.external_key,
      context: input.context,
    });

    const promotedAt = new Date().toISOString();
    await commandHandler({
      streamId: sourceObservationStreamId(input.observation.observation_id),
      command: {
        type: "PromoteSourceObservation",
        catalogItemId,
        promotedAt,
      },
      context: input.context,
    });

    return {
      observationId: input.observation.observation_id,
      catalogItemId,
    };
  }

  async function promoteObservationIds(input: {
    observationIds: readonly string[];
    context: EventStoreContext;
  }): Promise<BulkSourceObservationPromotionResult> {
    const requestedIds = uniqueObservationIds(input.observationIds);
    const outcomes: BulkSourceObservationPromotionOutcome[] = [];

    for (const observationId of requestedIds) {
      try {
        const observation = await getSourceObservationDetail(deps.db, observationId);

        if (!observation) {
          outcomes.push({
            observationId,
            status: "failed",
            catalogItemId: null,
            reason: "Source observation was not found.",
          });
          continue;
        }

        if (observation.status !== "observed") {
          outcomes.push({
            observationId,
            status: "skipped",
            catalogItemId: observation.promoted_catalog_item_id as CatalogItemId | null,
            reason: `Source observation is already ${observation.status}.`,
          });
          continue;
        }

        const promoted = await promoteObservationFromRow({
          observation,
          context: input.context,
        });
        outcomes.push({
          observationId,
          status: "promoted",
          catalogItemId: promoted.catalogItemId,
          reason: null,
        });
      } catch (error) {
        outcomes.push({
          observationId,
          status: "failed",
          catalogItemId: null,
          reason: error instanceof Error ? error.message : "Promotion failed.",
        });
      }
    }

    await drainRuntimeProjectors([...items.projectors, ...projectors]);

    return summarizePromotionOutcomes(requestedIds.length, outcomes);
  }

  return {
    commandHandler,
    importTcgdexSet: async ({ languageCode, setId, context }) => {
      const observations = await fetchTcgdexSetObservations({
        languageCode,
        setId,
        assetStorage: deps.assetStorage,
      });

      for (const observation of observations) {
        await recordObservation(observation, context);
      }
      await drainRuntimeProjectors(projectors);

      return {
        setId,
        expansionId: setId,
        languageCode,
        observed: observations.length,
        observationIds: observations.map((observation) => observation.observationId),
      };
    },
    promoteObservation: async ({ observationId, context }) => {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation) {
        throw new Error("Source observation was not found.");
      }

      if (observation.status !== "observed") {
        throw new Error("Only observed source observations can be promoted.");
      }

      const result = await promoteObservationFromRow({ observation, context });
      await drainRuntimeProjectors([...items.projectors, ...projectors]);

      return result;
    },
    promoteObservations: promoteObservationIds,
    previewPromoteObservationScope: async ({ scope }) =>
      previewSourceObservationPromotionScope(deps.db, scope),
    promoteObservationScope: async ({ scope, context }) => {
      const observationIds = await listSourceObservationIdsForPromotion(deps.db, scope);
      return promoteObservationIds({
        observationIds,
        context,
      });
    },
    rejectObservation: async ({ observationId, reason, context }) => {
      await commandHandler({
        streamId: sourceObservationStreamId(observationId),
        command: {
          type: "RejectSourceObservation",
          reason,
        },
        context,
      });
      await drainRuntimeProjectors(projectors);

      return { observationId, status: "rejected" };
    },
    listSourceObservations: (params) => listSourceObservations(deps.db, params),
    listIntegrationScopes: (params) =>
      listSourceObservationIntegrationScopes(deps.db, params),
    getSourceObservationDetail: (observationId) =>
      getSourceObservationDetail(deps.db, observationId),
    projectors,
  };
}

async function drainRuntimeProjectors(projectors: readonly Projector[]) {
  for (;;) {
    let processed = 0;
    for (const projector of projectors) {
      processed += (await projector.runOnce()).processed;
    }

    if (processed === 0) {
      return;
    }
  }
}

async function createCatalogDraftFromObservation(input: {
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  deps: CatalogRuntimeDeps;
  catalogItemId: CatalogItemId;
  normalized: SourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  context: EventStoreContext;
}) {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const subtitle = `${input.normalized.expansionName} ${input.normalized.cardNumber}`;
  const expansionReferenceId = await ensurePokemonReferenceHierarchy({
    deps: input.deps,
    referenceData: input.referenceData,
    normalized: input.normalized,
    context: input.context,
  });

  await input.items.commandHandler({
    streamId,
    command: {
      type: "CreateCatalogItem",
      itemId: input.catalogItemId,
      languageCode: input.normalized.languageCode,
      title: localizedText(input.normalized.name),
      subtitle: localizedText(subtitle),
      description: localizedText(""),
    },
    context: input.context,
  });
  await input.items.commandHandler({
    streamId,
    command: {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: catalogSeedIds.blueprints.pokemonCardSingle as BlueprintId,
    },
    context: input.context,
  });
  await setFieldValue(input, "cardNumber", input.normalized.cardNumber);
  await setFieldValue(input, "cardName", localizedJsonText(input.normalized.name));
  await setFieldValue(input, "expansion", { referenceId: expansionReferenceId });

  if (input.normalized.rarity) {
    await setFieldValue(input, "rarity", input.normalized.rarity);
  }

  if (input.normalized.illustrator) {
    await setFieldValue(input, "cardIllustrator", input.normalized.illustrator);
  }

  if (input.normalized.releaseYear !== null) {
    await setFieldValue(input, "releaseYear", input.normalized.releaseYear);
  }

  await input.items.commandHandler({
    streamId,
    command: {
      type: "AssignCatalogItemToCategory",
      categoryId: catalogSeedIds.categories.singles as CategoryId,
    },
    context: input.context,
  });
  await input.items.commandHandler({
    streamId,
    command: {
      type: "SetCatalogItemTags",
      tags: [
        "pokemon",
        "tcgdex",
        `expansion:${input.normalized.expansionId}`,
        `category:${input.normalized.category.toLowerCase()}`,
      ],
    },
    context: input.context,
  });
  await input.items.commandHandler({
    streamId,
    command: {
      type: "SetCatalogItemImageUrls",
      imageUrls: [...input.normalized.imageUrls],
    },
    context: input.context,
  });
  if (input.normalized.productAssetSet) {
    await input.items.commandHandler({
      streamId,
      command: {
        type: "SetCatalogItemProductAssetSets",
        productAssetSets: [input.normalized.productAssetSet],
      },
      context: input.context,
    });
  }
  await input.items.commandHandler({
    streamId,
    command: {
      type: "LinkExternalProductReference",
      providerKey: input.providerKey,
      externalKey: `${input.normalized.languageCode}:${input.externalKey}`,
    },
    context: input.context,
  });
}

async function setFieldValue(
  input: {
    items: CatalogItemServices;
    catalogItemId: CatalogItemId;
    context: EventStoreContext;
  },
  key: keyof typeof catalogFieldByKey,
  value: JsonValue,
) {
  await input.items.commandHandler({
    streamId: `catalog.item-${input.catalogItemId}`,
    command: {
      type: "SetCatalogItemFieldValue",
      fieldId: catalogFieldByKey[key] as FieldId,
      value,
    },
    context: input.context,
  });
}

const catalogFieldByKey = {
  cardNumber: catalogSeedIds.fields.cardNumber,
  cardName: catalogSeedIds.fields.cardName,
  expansion: catalogSeedIds.fields.expansion,
  rarity: catalogSeedIds.fields.rarity,
  cardIllustrator: catalogSeedIds.fields.cardIllustrator,
  releaseYear: catalogSeedIds.fields.releaseYear,
} as const;

async function ensurePokemonReferenceHierarchy(input: {
  deps: CatalogRuntimeDeps;
  referenceData: ReferenceDataServices;
  normalized: SourceObservationNormalized;
  context: EventStoreContext;
}): Promise<ReferenceRecordId> {
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.manufacturer as ReferenceTypeId,
    key: "manufacturer",
    name: "Manufacturer",
    description: "A company responsible for publishing or manufacturing catalog products.",
    attributeKeys: ["homepage-url"],
  });
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.productLine as ReferenceTypeId,
    key: "product-line",
    name: "Product Line",
    description: "A branded collectible product line.",
    attributeKeys: ["official-name", "short-name"],
  });
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.series as ReferenceTypeId,
    key: "series",
    name: "Series",
    description: "An official Pokemon TCG series that groups expansions.",
    attributeKeys: ["tcgdex-series-id"],
  });
  await ensureReferenceType(input, {
    referenceTypeId: catalogSeedIds.referenceTypes.expansion as ReferenceTypeId,
    key: "expansion",
    name: "Expansion",
    description: "An official Pokemon TCG card expansion.",
    attributeKeys: [
      "abbreviation",
      "card-count",
      "parallel-set-card-count",
      "release-date",
      "tcgdex-set-id",
    ],
  });

  const manufacturerId = await ensureReferenceRecord(input, {
    referenceRecordId:
      catalogSeedIds.referenceRecords.manufacturers.thePokemonCompanyInternational,
    typeKey: "manufacturer",
    key: "the-pokemon-company-international",
    name: "The Pokemon Company International",
    description: "Publisher of the English Pokemon Trading Card Game.",
    attributes: { "homepage-url": "https://www.pokemon.com/us" },
  });
  const productLineId = await ensureReferenceRecord(input, {
    referenceRecordId:
      catalogSeedIds.referenceRecords.productLines.pokemonTradingCardGame,
    typeKey: "product-line",
    key: "pokemon-trading-card-game",
    name: "Pokemon Trading Card Game",
    description: "The Pokemon Trading Card Game product line.",
    attributes: {
      "official-name": "Pokemon Trading Card Game",
      "short-name": "Pokemon TCG",
    },
    relationships: [{ relationshipType: "published-by", referenceId: manufacturerId }],
  });
  const seriesReferenceId = input.normalized.seriesName
    ? await ensureReferenceRecord(input, {
        referenceRecordId: createId("ref") as ReferenceRecordId,
        typeKey: "series",
        key: normalizeReferenceKey(input.normalized.seriesName),
        name: input.normalized.seriesName,
        description: `${input.normalized.seriesName} Pokemon TCG series.`,
        attributes: input.normalized.seriesId
          ? { "tcgdex-series-id": input.normalized.seriesId }
          : {},
        relationships: [{ relationshipType: "part-of", referenceId: productLineId }],
      })
    : productLineId;

  const expansionAttributes: Record<string, JsonValue> = {
    "tcgdex-set-id": input.normalized.expansionId,
  };

  if (input.normalized.releaseDate) {
    expansionAttributes["release-date"] = input.normalized.releaseDate;
  }

  if (input.normalized.expansionAbbreviation) {
    expansionAttributes.abbreviation = input.normalized.expansionAbbreviation;
  }

  if (input.normalized.expansionCardCount !== null) {
    expansionAttributes["card-count"] = input.normalized.expansionCardCount;
  }

  if (input.normalized.expansionParallelSetCardCount !== null) {
    expansionAttributes["parallel-set-card-count"] =
      input.normalized.expansionParallelSetCardCount;
  }

  return ensureReferenceRecord(input, {
    referenceRecordId: createId("ref") as ReferenceRecordId,
    typeKey: "expansion",
    key: normalizeReferenceKey(input.normalized.expansionName),
    name: input.normalized.expansionName,
    description: `${input.normalized.expansionName} Pokemon TCG expansion.`,
    attributes: expansionAttributes,
    relationships: [{ relationshipType: "part-of", referenceId: seriesReferenceId }],
  });
}

async function ensureReferenceType(
  input: {
    deps: CatalogRuntimeDeps;
    referenceData: ReferenceDataServices;
    context: EventStoreContext;
  },
  def: {
    referenceTypeId: ReferenceTypeId;
    key: string;
    name: string;
    description: string;
    attributeKeys: readonly string[];
  },
): Promise<void> {
  const existing = await input.deps.db.query(
    "SELECT reference_type_id FROM catalog_reference_types WHERE reference_type_id = $1",
    [def.referenceTypeId],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    return;
  }

  const streamId = `catalog.reference-type-${def.referenceTypeId}`;
  await input.referenceData.referenceTypeCommandHandler({
    streamId,
    command: {
      type: "CreateReferenceType",
      referenceTypeId: def.referenceTypeId,
      key: def.key,
      name: localizedText(def.name),
      description: localizedText(def.description),
      attributeKeys: def.attributeKeys,
    },
    context: input.context,
  });
  await input.referenceData.referenceTypeCommandHandler({
    streamId,
    command: { type: "PublishReferenceType" },
    context: input.context,
  });
  await drainRuntimeProjectors(input.referenceData.projectors);
}

async function ensureReferenceRecord(
  input: {
    deps: CatalogRuntimeDeps;
    referenceData: ReferenceDataServices;
    context: EventStoreContext;
  },
  def: {
    referenceRecordId: ReferenceRecordId;
    typeKey: string;
    key: string;
    name: string;
    description: string;
    attributes?: Readonly<Record<string, JsonValue>>;
    relationships?: readonly ReferenceRelationship[];
  },
): Promise<ReferenceRecordId> {
  const existing = await input.deps.db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id
     FROM catalog_reference_records
     WHERE type_key = $1 AND key = $2
     LIMIT 1`,
    [def.typeKey, def.key],
  );

  if (existing.rows[0]?.reference_record_id) {
    return existing.rows[0].reference_record_id as ReferenceRecordId;
  }

  const streamId = `catalog.reference-record-${def.referenceRecordId}`;
  await input.referenceData.referenceRecordCommandHandler({
    streamId,
    command: {
      type: "CreateReferenceRecord",
      referenceRecordId: def.referenceRecordId,
      typeKey: def.typeKey,
      key: def.key,
      name: localizedText(def.name),
      description: localizedText(def.description),
      attributes: def.attributes ?? {},
      relationships: def.relationships ?? [],
    },
    context: input.context,
  });
  await input.referenceData.referenceRecordCommandHandler({
    streamId,
    command: { type: "PublishReferenceRecord" },
    context: input.context,
  });
  await drainRuntimeProjectors(input.referenceData.projectors);

  return def.referenceRecordId;
}

function localizedText(value: string): LocalizedTextMap {
  return {
    defaultLocale: "en" as const,
    values: {
      en: value,
    },
  };
}

function normalizeReferenceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function localizedJsonText(value: string): JsonObject {
  return {
    defaultLocale: "en",
    values: {
      en: value,
    },
  };
}

function sourceObservationStreamId(observationId: string): string {
  return `catalog.source-observation-${observationId}`;
}

function uniqueObservationIds(observationIds: readonly string[]): string[] {
  return Array.from(
    new Set(
      observationIds
        .map((observationId) => observationId.trim())
        .filter((observationId) => observationId.length > 0),
    ),
  );
}

function summarizePromotionOutcomes(
  requested: number,
  outcomes: readonly BulkSourceObservationPromotionOutcome[],
): BulkSourceObservationPromotionResult {
  return {
    requested,
    promoted: outcomes.filter((outcome) => outcome.status === "promoted").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  };
}
