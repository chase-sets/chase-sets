import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { ListingAuthorityConsumerPort, ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import { toJsonValue } from "@chase-sets/primitives/json";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { resolveProduct } from "../../../support/runtime-support/versioning";
import type { CatalogItemId, SelectedOptionEntry } from "../../../ids";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
} from "../../catalog-items/domain/domain";
import {
  decideBlueprint,
  evolveBlueprint,
  initialBlueprintState,
  type BlueprintEvent,
} from "../../blueprints/domain/domain";
import {
  decideDimension,
  evolveDimension,
  initialDimensionState,
  type DimensionEvent,
} from "../../dimensions/domain/domain";
import {
  productMeasureProfilesStream,
  productMeasureProfileRecorded,
  readAuthoritativeProductMeasureProfiles,
} from "./profiles";
import { enumerateProducts, resolveProductMeasures } from "./runtime";

export type CatalogListingAuthorityConsumer = (operation: ListingAuthorityOperation) => ListingAuthorityConsumerPort;

export function createCatalogListingAuthority(deps: CatalogRuntimeDeps, consumer: CatalogListingAuthorityConsumer) {
  const { repository: items } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CatalogItemEvent>(),
    initialState: () => initialCatalogItemState,
    evolve: evolveCatalogItem,
    decide: decideCatalogItem,
  });
  const { repository: blueprints } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<BlueprintEvent>(),
    initialState: () => initialBlueprintState,
    evolve: evolveBlueprint,
    decide: decideBlueprint,
  });
  const { repository: dimensions } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<DimensionEvent>(),
    initialState: () => initialDimensionState,
    evolve: evolveDimension,
    decide: decideDimension,
  });
  const resourceIds = (itemId: string, blueprintId: string | null, operation: ListingAuthorityOperation) => [
    `item/${itemId}`,
    "measure-profiles/global",
    ...(blueprintId ? [`blueprint/${blueprintId}`, `measure-profiles/blueprint/${blueprintId}`] : []),
    ...operation.subject.selectedOptions.map((option) => `dimension/${option.dimensionId}`),
  ];
  const source = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    participant: { owner: "catalog", purpose: "product-measures" },
    resourceScope: "owner",
    consumer,
    resources: async (operation) => {
      const item = await items.load(`catalog.item-${operation.subject.catalogItemId}`);
      return resourceIds(operation.subject.catalogItemId, item.state.blueprintId, operation);
    },
    validate: async (operation, context) => {
      const subject = operation.subject;
      const itemStream = `catalog.item-${subject.catalogItemId}`;
      const item = await items.load(itemStream);
      if (item.state.id !== subject.catalogItemId || item.state.status !== "active" || !item.state.blueprintId) {
        throw new Error("Catalog Product is not currently published.");
      }
      const blueprintStream = `catalog.blueprint-${item.state.blueprintId}`;
      const blueprint = await blueprints.load(blueprintStream);
      if (blueprint.state.id !== item.state.blueprintId || blueprint.state.status !== "active") {
        throw new Error("Catalog Product Blueprint is not active.");
      }
      const product = resolveProduct({
        catalogItemId: subject.catalogItemId as CatalogItemId,
        blueprint: blueprint.state,
        selectedOptions: subject.selectedOptions as readonly SelectedOptionEntry[],
      });
      if (
        product.productId !== subject.productId ||
        JSON.stringify(product.selectedOptions) !== JSON.stringify(subject.selectedOptions)
      ) {
        throw new Error("Listing Product selection is not Catalog's canonical selection.");
      }
      const selectedDimensions = await Promise.all(
        subject.selectedOptions.map(async (selection) => {
          const streamId = `catalog.dimension-${selection.dimensionId}`;
          const dimension = await dimensions.load(streamId);
          if (
            dimension.state.id !== selection.dimensionId ||
            dimension.state.status !== "active" ||
            !dimension.state.options.some((option) => option.id === selection.optionId && option.status === "active")
          ) {
            throw new Error("Catalog Product selects an unavailable Dimension Option.");
          }
          return { streamId, version: dimension.version };
        }),
      );
      const profiles = await readAuthoritativeProductMeasureProfiles(deps.eventStore);
      const measures = resolveProductMeasures(
        {
          catalog_item_id: subject.catalogItemId,
          blueprint_id: item.state.blueprintId,
          category_ids: item.state.categoryIds,
          dimension_rules: blueprint.state.dimensionRules,
          canonical_dimension_order: blueprint.state.canonicalDimensionOrder,
        },
        [product],
        profiles.profiles,
      );
      const measureStream = `catalog.product-measures-${subject.catalogItemId}`;
      const measureHistory = await readCompleteStream(deps.eventStore, { streamId: measureStream });
      const resolved = measureHistory.at(-1);
      const recordedProducts = resolved?.payload.products;
      if (
        !Array.isArray(recordedProducts) ||
        !recordedProducts.some((entry) => JSON.stringify(entry) === JSON.stringify(toJsonValue(measures[0] ?? null)))
      ) {
        if (measures.length)
          throw new Error("Catalog measure publication is not current with its authoritative inputs.");
      }
      return {
        value: {
          catalogItemId: subject.catalogItemId,
          productId: product.productId,
          selectedOptions: toJsonValue(product.selectedOptions),
          productMeasureSnapshot: toJsonValue(measures[0] ?? null),
          productMeasureRevision: resolved?.streamVersion ?? 0,
        },
        resources: resourceIds(subject.catalogItemId, item.state.blueprintId, operation),
        sourceRevisions: [
          { resourceId: itemStream, revision: String(item.version) },
          { resourceId: blueprintStream, revision: String(blueprint.version) },
          { resourceId: productMeasureProfilesStream, revision: String(profiles.revision) },
          { resourceId: measureStream, revision: String(resolved?.streamVersion ?? 0) },
          ...selectedDimensions.map((dimension) => ({
            resourceId: dimension.streamId,
            revision: String(dimension.version),
          })),
        ],
        validBefore: operation.prepareBefore,
        localAppends: [
          { streamId: itemStream, expectedVersion: item.version, context, events: [] },
          { streamId: blueprintStream, expectedVersion: blueprint.version, context, events: [] },
          { streamId: productMeasureProfilesStream, expectedVersion: profiles.revision, context, events: [] },
          { streamId: measureStream, expectedVersion: resolved?.streamVersion ?? 0, context, events: [] },
          ...selectedDimensions.map((dimension) => ({
            streamId: dimension.streamId,
            expectedVersion: dimension.version,
            context,
            events: [],
          })),
        ],
      };
    },
  });
  const writer = createListingAuthorityWriter({
    eventStore: deps.eventStore,
    source,
    owner: "catalog",
    resources: async (inputs) =>
      (
        await Promise.all(
          inputs.map(async (input) => {
            if (!input.events.length) return [];
            if (input.streamId === productMeasureProfilesStream) {
              const current = await readAuthoritativeProductMeasureProfiles(deps.eventStore);
              return input.events.flatMap((event) => {
                if (event.eventType !== productMeasureProfileRecorded || !event.payload.profile)
                  throw new Error("Unknown Product Measure Profile mutation.");
                const profile = event.payload.profile as { profileId: string; matchBlueprintId?: string | null };
                const prior = current.profiles.find((entry) => entry.profile_id === profile.profileId);
                const scope = (blueprintId: string | null | undefined) =>
                  blueprintId ? `measure-profiles/blueprint/${blueprintId}` : "measure-profiles/global";
                return [scope(profile.matchBlueprintId), ...(prior ? [scope(prior.match_blueprint_id)] : [])];
              });
            }
            if (input.streamId.startsWith("catalog.product-measures-"))
              return [`item/${input.streamId.slice("catalog.product-measures-".length)}`];
            for (const noun of ["item", "blueprint", "dimension"]) {
              const prefix = `catalog.${noun}-`;
              if (input.streamId.startsWith(prefix)) return [`${noun}/${input.streamId.slice(prefix.length)}`];
            }
            return [];
          }),
        )
      ).flat(),
  });
  return {
    source: {
      ...source,
      async prepare(operation: ListingAuthorityOperation, context: Parameters<typeof source.prepare>[1]) {
        if (await source.inspect(operation)) return source.prepare(operation, context);
        if ((await consumer(operation).inspect(operation)).status !== "pending")
          throw new Error("Catalog consumer is not pending.");
        const itemStream = `catalog.item-${operation.subject.catalogItemId}`;
        const item = await items.load(itemStream);
        if (!item.state.blueprintId) throw new Error("Catalog Product has no Blueprint.");
        const blueprintStream = `catalog.blueprint-${item.state.blueprintId}`;
        const blueprint = await blueprints.load(blueprintStream);
        const profiles = await readAuthoritativeProductMeasureProfiles(deps.eventStore);
        const row = {
          catalog_item_id: operation.subject.catalogItemId,
          blueprint_id: item.state.blueprintId,
          category_ids: item.state.categoryIds,
          dimension_rules: blueprint.state.dimensionRules,
          canonical_dimension_order: blueprint.state.canonicalDimensionOrder,
        };
        const products = resolveProductMeasures(row, enumerateProducts(row), profiles.profiles);
        const streamId = `catalog.product-measures-${operation.subject.catalogItemId}`;
        const history = await readCompleteStream(deps.eventStore, { streamId });
        const payload = { catalogItemId: operation.subject.catalogItemId, products: toJsonValue(products) };
        if (JSON.stringify(history.at(-1)?.payload) !== JSON.stringify(payload)) {
          await writer.eventStore.appendToStreams!([
            { streamId: itemStream, expectedVersion: item.version, context, events: [] },
            { streamId: blueprintStream, expectedVersion: blueprint.version, context, events: [] },
            { streamId: productMeasureProfilesStream, expectedVersion: profiles.revision, context, events: [] },
            {
              streamId,
              expectedVersion: history.at(-1)?.streamVersion ?? 0,
              context,
              events: [{ eventType: "catalog.catalog-item.product-measures-resolved", payload }],
            },
          ]);
        }
        return source.prepare(operation, context);
      },
    },
    ...writer,
  };
}
