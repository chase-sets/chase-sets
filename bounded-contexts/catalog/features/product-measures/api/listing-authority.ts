import { isDeepStrictEqual } from "node:util";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { ListingAuthorityConsumerPort, ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue } from "@chase-sets/primitives/json";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import { createListingAuthorityRecovery } from "@chase-sets/platform-runtime/listing-authority-recovery";
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

export type CatalogListingAuthorityFacts = Readonly<{
  catalogItemId: string;
  productId: string;
  blueprintId: string;
  categoryIds: readonly string[];
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  productMeasureSnapshot: ProductMeasureSnapshot | null;
  productMeasureRevision: number;
}>;
export type CatalogListingProductSubject = Pick<
  CatalogListingAuthorityFacts,
  "catalogItemId" | "productId" | "selectedOptions"
>;

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
  const resourceIds = (itemId: string, blueprintId: string | null, subject: CatalogListingProductSubject) => [
    `item/${itemId}`,
    "measure-profiles/global",
    ...(blueprintId ? [`blueprint/${blueprintId}`, `measure-profiles/blueprint/${blueprintId}`] : []),
    ...subject.selectedOptions.map((option) => `dimension/${option.dimensionId}`),
  ];
  async function validate(
    subject: CatalogListingProductSubject,
    validBefore: string,
    context?: EventStoreContext,
    cache?: Map<string, Promise<unknown>>,
  ) {
    const read = <T>(key: string, load: () => Promise<T>): Promise<T> => {
      const existing = cache?.get(key) as Promise<T> | undefined;
      if (existing) return existing;
      const value = load();
      cache?.set(key, value);
      return value;
    };
    const itemStream = `catalog.item-${subject.catalogItemId}`;
    const item = await read(itemStream, () => items.load(itemStream));
    if (item.state.id !== subject.catalogItemId || item.state.status !== "active" || !item.state.blueprintId) {
      throw new Error("Catalog Product is not currently published.");
    }
    const blueprintStream = `catalog.blueprint-${item.state.blueprintId}`;
    const blueprint = await read(blueprintStream, () => blueprints.load(blueprintStream));
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
      !isDeepStrictEqual(product.selectedOptions, subject.selectedOptions)
    ) {
      throw new Error("Listing Product selection is not Catalog's canonical selection.");
    }
    const selectedDimensions = await Promise.all(
      subject.selectedOptions.map(async (selection) => {
        const streamId = `catalog.dimension-${selection.dimensionId}`;
        const dimension = await read(streamId, () => dimensions.load(streamId));
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
    const profiles = await read(productMeasureProfilesStream, () =>
      readAuthoritativeProductMeasureProfiles(deps.eventStore),
    );
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
    const measureHistory = await read(measureStream, () =>
      readCompleteStream(deps.eventStore, { streamId: measureStream }),
    );
    const resolved = measureHistory.at(-1);
    const recordedProducts = resolved?.payload.products;
    if (
      !Array.isArray(recordedProducts) ||
      !recordedProducts.some((entry) => isDeepStrictEqual(entry, toJsonValue(measures[0] ?? null)))
    ) {
      if (measures.length) throw new Error("Catalog measure publication is not current with its authoritative inputs.");
    }
    return {
      value: {
        catalogItemId: subject.catalogItemId,
        productId: product.productId,
        blueprintId: item.state.blueprintId,
        categoryIds: [...item.state.categoryIds],
        selectedOptions: toJsonValue(product.selectedOptions),
        productMeasureSnapshot: toJsonValue(measures[0] ?? null),
        productMeasureRevision: resolved?.streamVersion ?? 0,
      },
      resources: resourceIds(subject.catalogItemId, item.state.blueprintId, subject),
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
      validBefore,
      localAppends: context
        ? [
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
          ]
        : [],
    };
  }
  const source = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    participant: { owner: "catalog", purpose: "product-measures" },
    resourceScope: "owner",
    consumer,
    resources: async (operation) => {
      const item = await items.load(`catalog.item-${operation.subject.catalogItemId}`);
      return resourceIds(operation.subject.catalogItemId, item.state.blueprintId, operation.subject);
    },
    validate: (operation, context) => validate(operation.subject, operation.prepareBefore, context),
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
    async readCurrentProducts(
      subjects: readonly CatalogListingProductSubject[],
      input: Readonly<{ maxAgeMs: number }>,
    ) {
      if (subjects.length > 100 || !Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0)
        throw new Error("Catalog current facts require at most 100 Products and a positive read-age budget.");
      if (
        subjects.some(
          (subject) =>
            !subject.catalogItemId.trim() || !subject.productId.trim() || subject.selectedOptions.length > 28,
        )
      )
        throw new Error("Catalog current facts require bounded Product identities and selections.");
      const validBefore = new Date(Date.now() + input.maxAgeMs).toISOString();
      const cache = new Map<string, Promise<unknown>>();
      const resolved = await Promise.all(subjects.map((subject) => validate(subject, validBefore, undefined, cache)));
      const revisions = new Map<string, string>();
      for (const fact of resolved)
        for (const revision of fact.sourceRevisions) {
          const prior = revisions.get(revision.resourceId);
          if (prior !== undefined && prior !== revision.revision)
            throw new Error("Catalog inputs changed during current read.");
          revisions.set(revision.resourceId, revision.revision);
        }
      const check = await deps.db.query<{ generated_at: Date | string; current: boolean }>(
        `
        WITH expected AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(stream_id text, revision bigint))
        SELECT clock_timestamp() AS generated_at,
          (NOT EXISTS (SELECT 1 FROM expected LEFT JOIN event_store_streams source USING (stream_id)
            WHERE COALESCE(source.current_version,0) <> expected.revision)
           AND NOT EXISTS (SELECT 1 FROM catalog_product_measure_profiles WHERE source_revision=0)) AS current`,
        [JSON.stringify([...revisions].map(([stream_id, revision]) => ({ stream_id, revision })))],
      );
      const checked = check.rows[0];
      const generatedAt = checked ? new Date(checked.generated_at).toISOString() : null;
      if (!checked?.current || !generatedAt || Date.parse(generatedAt) >= Date.parse(validBefore))
        throw new Error("Catalog current facts are stale or unreconciled.");
      return {
        value: resolved.map((fact) => fact.value as unknown as CatalogListingAuthorityFacts),
        generatedAt,
        validBefore,
      };
    },
    recover: createListingAuthorityRecovery({
      db: deps.db,
      owner: "catalog",
      sources: [source],
      consumer,
      resume: writer.resume,
      resumeWrite: writer.resumeWrite,
    }),
    async readFacts(operation: ListingAuthorityOperation): Promise<CatalogListingAuthorityFacts> {
      const grant = await source.inspect(operation);
      if (!grant || grant.status !== "reserved") throw new Error("Catalog authority is not reserved.");
      return grant.value as unknown as CatalogListingAuthorityFacts;
    },
    source: {
      ...source,
      async prepare(operation: ListingAuthorityOperation, context: Parameters<typeof source.prepare>[1]) {
        if (await source.inspect(operation)) return source.prepare(operation, context);
        const legacy = await deps.db.query<{ profile_id: string }>(
          `SELECT profile_id FROM catalog_product_measure_profiles WHERE source_revision = 0 LIMIT 1`,
        );
        if (legacy.rows.length)
          throw new Error("Catalog Product Measure Profile authority reconciliation is incomplete.");
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
        if (!isDeepStrictEqual(history.at(-1)?.payload, payload)) {
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
