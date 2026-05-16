import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { CatalogDomainError } from "../../../support/runtime-support/common";
import type { CatalogItemId, FieldId } from "../../../ids";
import { asArray, asStringArray, type FieldRule, type FieldValue } from "../../../support/projection-support/read-model-support";
import {
  type CatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
  initialCatalogItemState,
  decideCatalogItem,
  evolveCatalogItem,
} from "../domain/domain";
import {
  getCatalogItemDetail,
  listCatalogItemIdsForBulkPublishFilter,
  listCatalogItems,
  listCatalogItemsForBulkPublish,
  type CatalogItemListParams,
  type BulkPublishCatalogItemRow,
} from "../read-model/queries";
import { buildCatalogAdminCatalogItemProjectionHandlers } from "../read-model/admin-projection";
import { buildCatalogItemProjectionHandlers } from "../read-model/projection";

export type BulkPublishSelection =
  | Readonly<{ mode: "ids"; ids: readonly string[] }>
  | Readonly<{ mode: "filter"; query: CatalogItemListParams }>;

export type BulkPublishCandidateStatus = "ready" | "blocked" | "published" | "failed" | "skipped";

export type BulkPublishCandidate = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  status: string;
  blueprint_id: string | null;
  blueprint_name: string | null;
  source_providers: readonly string[];
  outcome: BulkPublishCandidateStatus;
  reason: string | null;
  required_field_ids: readonly string[];
}>;

export type BulkPublishPreview = Readonly<{
  mode: BulkPublishSelection["mode"];
  item_ids: readonly string[];
  total: number;
  ready_count: number;
  blocked_count: number;
  candidates: readonly BulkPublishCandidate[];
}>;

export type BulkPublishResult = Readonly<{
  item_ids: readonly string[];
  total: number;
  published_count: number;
  failed_count: number;
  skipped_count: number;
  candidates: readonly BulkPublishCandidate[];
}>;

export type CatalogItemServices = Readonly<{
  commandHandler: CommandHandler<
    CatalogItemCommand,
    CatalogItemState,
    CatalogItemEvent
  >;
  listCatalogItems: (
    params?: Parameters<typeof listCatalogItems>[1],
  ) => ReturnType<typeof listCatalogItems>;
  getCatalogItemDetail: (
    itemId: string,
  ) => ReturnType<typeof getCatalogItemDetail>;
  previewBulkPublish: (
    selection: BulkPublishSelection,
  ) => Promise<BulkPublishPreview>;
  publishBulk: (
    itemIds: readonly string[],
    context: EventStoreContext,
  ) => Promise<BulkPublishResult>;
  projectors: readonly Projector[];
}>;

export function createCatalogItemRuntime(
  deps: CatalogRuntimeDeps,
): CatalogItemServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CatalogItemEvent>(),
      initialState: () => initialCatalogItemState,
      evolve: evolveCatalogItem,
    }),
    evolve: evolveCatalogItem,
    decide: decideCatalogItem,
  });

  return {
    commandHandler,
    listCatalogItems: (params) => listCatalogItems(deps.db, params),
    getCatalogItemDetail: (itemId) => getCatalogItemDetail(deps.db, itemId),
    previewBulkPublish: async (selection) => previewBulkPublish(deps, selection),
    publishBulk: async (itemIds, context) => publishBulk(deps, commandHandler, itemIds, context),
    projectors: [
      createProjector({
        projectorName: "catalog-item-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCatalogItemProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "catalog-admin-catalog-item-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCatalogAdminCatalogItemProjectionHandlers(deps.db),
      }),
    ],
  };
}

async function previewBulkPublish(
  deps: CatalogRuntimeDeps,
  selection: BulkPublishSelection,
): Promise<BulkPublishPreview> {
  const itemIds = await resolveBulkPublishItemIds(deps, selection);
  const candidates = await classifyBulkPublishCandidates(deps, itemIds);
  const readyCount = candidates.filter((candidate) => candidate.outcome === "ready").length;

  return {
    mode: selection.mode,
    item_ids: itemIds,
    total: candidates.length,
    ready_count: readyCount,
    blocked_count: candidates.length - readyCount,
    candidates,
  };
}

async function publishBulk(
  deps: CatalogRuntimeDeps,
  commandHandler: CatalogItemServices["commandHandler"],
  itemIds: readonly string[],
  context: EventStoreContext,
): Promise<BulkPublishResult> {
  const normalizedIds = normalizeRequestedItemIds(itemIds);
  const preview = await classifyBulkPublishCandidates(deps, normalizedIds);
  const results: BulkPublishCandidate[] = [];

  for (const candidate of preview) {
    if (candidate.outcome !== "ready") {
      results.push({ ...candidate, outcome: "skipped" });
      continue;
    }

    try {
      const result = await commandHandler({
        streamId: `catalog.item-${candidate.catalog_item_id}`,
        command: {
          type: "PublishCatalogItem",
          blueprintIsActive: true,
          requiredFieldIds: candidate.required_field_ids as readonly FieldId[],
        },
        context,
      });

      results.push({
        ...candidate,
        status: result.state.status,
        outcome: "published",
        reason: null,
      });
    } catch (error) {
      results.push({
        ...candidate,
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    item_ids: normalizedIds,
    total: results.length,
    published_count: results.filter((candidate) => candidate.outcome === "published").length,
    failed_count: results.filter((candidate) => candidate.outcome === "failed").length,
    skipped_count: results.filter((candidate) => candidate.outcome === "skipped").length,
    candidates: results,
  };
}

async function resolveBulkPublishItemIds(
  deps: CatalogRuntimeDeps,
  selection: BulkPublishSelection,
): Promise<string[]> {
  if (selection.mode === "ids") {
    return normalizeRequestedItemIds(selection.ids);
  }

  return listCatalogItemIdsForBulkPublishFilter(deps.db, selection.query);
}

function normalizeRequestedItemIds(itemIds: readonly string[]): string[] {
  const normalized = Array.from(
    new Set(
      itemIds
        .map((itemId) => itemId.trim())
        .filter(Boolean),
    ),
  );

  if (normalized.length === 0) {
    throw new CatalogDomainError("Choose at least one draft Catalog Item to publish.");
  }

  return normalized;
}

async function classifyBulkPublishCandidates(
  deps: CatalogRuntimeDeps,
  itemIds: readonly string[],
): Promise<BulkPublishCandidate[]> {
  const rows = await listCatalogItemsForBulkPublish(deps.db, itemIds);
  const byId = new Map(rows.map((row) => [row.catalog_item_id, row]));

  return itemIds.map((itemId) => {
    const row = byId.get(itemId);

    if (!row) {
      return {
        catalog_item_id: itemId,
        title: itemId,
        subtitle: null,
        status: "missing",
        blueprint_id: null,
        blueprint_name: null,
        source_providers: [],
        outcome: "blocked",
        reason: "Catalog Item was not found.",
        required_field_ids: [],
      };
    }

    return classifyBulkPublishCandidate(row);
  });
}

function classifyBulkPublishCandidate(row: BulkPublishCatalogItemRow): BulkPublishCandidate {
  const requiredFieldIds = requiredFieldIdsFromBlueprint(row.blueprint_field_rules);
  const populatedFieldIds = new Set(
    asArray<FieldValue>(row.field_values)
      .map((fieldValue) => fieldValue.fieldId)
      .filter(Boolean),
  );
  const missingRequiredFieldIds = requiredFieldIds.filter((fieldId) => !populatedFieldIds.has(fieldId));
  let reason: string | null = null;

  if (row.status !== "draft") {
    reason = "Only draft Catalog Items can be bulk published.";
  } else if (!row.blueprint_id) {
    reason = "Catalog Item requires a blueprint before publish.";
  } else if (row.blueprint_status !== "active") {
    reason = "Catalog Item blueprint must be active before publish.";
  } else if (missingRequiredFieldIds.length > 0) {
    reason = `Missing required field values: ${missingRequiredFieldIds.join(", ")}.`;
  }

  return {
    catalog_item_id: row.catalog_item_id,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    blueprint_id: row.blueprint_id,
    blueprint_name: row.blueprint_name,
    source_providers: asStringArray(row.source_providers),
    outcome: reason ? "blocked" : "ready",
    reason,
    required_field_ids: requiredFieldIds,
  };
}

function requiredFieldIdsFromBlueprint(fieldRules: unknown): string[] {
  return asArray<FieldRule>(fieldRules)
    .filter((rule) => rule.required && typeof rule.fieldId === "string" && rule.fieldId.length > 0)
    .map((rule) => rule.fieldId);
}
