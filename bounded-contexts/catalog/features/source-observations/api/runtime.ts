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
import type { CatalogItemId, BlueprintId, CategoryId, FieldId } from "../../../ids";
import type { LocalizedTextMap } from "../../../support/runtime-support/common";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
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
  listSourceObservations,
} from "../read-model/queries";
import { fetchTcgdexSetObservations, type TcgdexSetImportResult } from "./tcgdex-client";

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
  rejectObservation: (input: {
    observationId: string;
    reason: string;
    context: EventStoreContext;
  }) => Promise<{ observationId: string; status: "rejected" }>;
  listSourceObservations: (
    params?: Parameters<typeof listSourceObservations>[1],
  ) => ReturnType<typeof listSourceObservations>;
  getSourceObservationDetail: (
    observationId: string,
  ) => ReturnType<typeof getSourceObservationDetail>;
  projectors: readonly Projector[];
}>;

export function createSourceObservationRuntime(
  deps: CatalogRuntimeDeps,
  items: CatalogItemServices,
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

      const catalogItemId = createId("cat") as CatalogItemId;
      const normalized = observation.normalized;
      await createCatalogDraftFromObservation({
        items,
        catalogItemId,
        normalized,
        providerKey: observation.provider_key,
        externalKey: observation.external_key,
        context,
      });

      const promotedAt = new Date().toISOString();
      await commandHandler({
        streamId: sourceObservationStreamId(observationId),
        command: {
          type: "PromoteSourceObservation",
          catalogItemId,
          promotedAt,
        },
        context,
      });
      await drainRuntimeProjectors([...items.projectors, ...projectors]);

      return { observationId, catalogItemId };
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
  catalogItemId: CatalogItemId;
  normalized: SourceObservationNormalized;
  providerKey: string;
  externalKey: string;
  context: EventStoreContext;
}) {
  const streamId = `catalog.item-${input.catalogItemId}`;
  const subtitle = `${input.normalized.setName} ${input.normalized.cardNumber}`;

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
  await setFieldValue(input, "setName", input.normalized.setName);

  if (input.normalized.rarity) {
    await setFieldValue(input, "rarity", input.normalized.rarity);
  }

  if (input.normalized.illustrator) {
    await setFieldValue(input, "artist", input.normalized.illustrator);
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
        `set:${input.normalized.setId}`,
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
  setName: catalogSeedIds.fields.setName,
  rarity: catalogSeedIds.fields.rarity,
  artist: catalogSeedIds.fields.artist,
  releaseYear: catalogSeedIds.fields.releaseYear,
} as const;

function localizedText(value: string): LocalizedTextMap {
  return {
    defaultLocale: "en" as const,
    values: {
      en: value,
    },
  };
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
