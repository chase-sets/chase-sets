import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { CatalogDomainError } from "../../../support/runtime-support/common";
import { withCatalogAdminRealtimeInvalidation } from "../../../support/projection-support/realtime-invalidation";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId } from "../../../ids";
import {
  createBulkLifecycleOperations,
  type BulkLifecycleOperations,
  type BulkLifecycleExecutionOptions,
  type BulkSelection,
} from "../../../support/runtime-support/bulk-lifecycle";
import {
  asArray,
  asStringArray,
  type FieldRule,
  type FieldValue,
} from "../../../support/projection-support/read-model-support";
import {
  type CatalogItemState,
  type CatalogItemCommand,
  type CatalogItemEvent,
  initialCatalogItemState,
  decideCatalogItem,
  evolveCatalogItem,
} from "../domain/domain";
import {
  getCatalogItemByGtin,
  getCatalogItemDetail,
  listCatalogItemsForBulkEdit,
  listCatalogItemBulkRows,
  listCatalogItemIds,
  listCatalogItemIdsForBulkPublishFilter,
  listCatalogItems,
  listCatalogItemsForBulkPublish,
  type CatalogItemGtinLookupRow,
  type CatalogItemListParams,
  type BulkEditCatalogItemRow,
  type BulkPublishCatalogItemRow,
} from "../read-model/queries";
import {
  buildCatalogAdminCatalogItemProjectionHandlers,
  refreshCatalogAdminCatalogItemPages,
} from "../read-model/admin-projection";
import { buildCatalogItemProjectionHandlers } from "../read-model/projection";
import {
  getCatalogItemDisplayIdentityRecomputeHealth,
  processCatalogItemDisplayIdentityRecomputeBatch,
  purgeCompletedCatalogItemDisplayIdentityRecomputeWork,
  type DisplayIdentityRecomputeBatchResult,
  type DisplayIdentityRecomputeHealth,
  type DisplayIdentityRecomputeRetentionOptions,
} from "../read-model/display-identity-recompute";

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

export type BulkEditCatalogItemAction =
  | "assignBlueprint"
  | "assignCategory"
  | "removeCategory"
  | "setTags"
  | "mergeTags"
  | "clearTags";

export type BulkEditCatalogItemOperation =
  | Readonly<{ action: "assignBlueprint"; blueprintId: string }>
  | Readonly<{ action: "assignCategory"; categoryId: string }>
  | Readonly<{ action: "removeCategory"; categoryId: string }>
  | Readonly<{ action: "setTags"; tags: readonly string[] }>
  | Readonly<{ action: "mergeTags"; tags: readonly string[] }>
  | Readonly<{ action: "clearTags" }>;

export type BulkEditCatalogItemCandidateOutcome = "ready" | "blocked" | "succeeded" | "skipped" | "failed";

export type BulkEditCatalogItemCandidate = Readonly<{
  catalog_item_id: string;
  title: string;
  status: string;
  blueprint_id: string | null;
  category_ids: readonly string[];
  tags: readonly string[];
  outcome: BulkEditCatalogItemCandidateOutcome;
  reason: string | null;
}>;

export type BulkEditCatalogItemPreview = Readonly<{
  mode: BulkSelection<CatalogItemListParams>["mode"];
  action: BulkEditCatalogItemAction;
  item_ids: readonly string[];
  total: number;
  ready_count: number;
  blocked_count: number;
  candidates: readonly BulkEditCatalogItemCandidate[];
}>;

export type BulkEditCatalogItemResult = Readonly<{
  action: BulkEditCatalogItemAction;
  item_ids: readonly string[];
  total: number;
  succeeded_count: number;
  skipped_count: number;
  failed_count: number;
  candidates: readonly BulkEditCatalogItemCandidate[];
}>;

export type CatalogItemServices = Readonly<{
  commandHandler: CommandHandler<CatalogItemCommand, CatalogItemState, CatalogItemEvent>;
  listCatalogItems: (params?: Parameters<typeof listCatalogItems>[1]) => ReturnType<typeof listCatalogItems>;
  getCatalogItemDetail: (itemId: string) => ReturnType<typeof getCatalogItemDetail>;
  getCatalogItemByGtin: (gtin: string) => Promise<CatalogItemGtinLookupRow | null>;
  previewBulkPublish: (selection: BulkPublishSelection) => Promise<BulkPublishPreview>;
  publishBulk: (
    itemIds: readonly string[],
    context: EventStoreContext,
    options?: BulkLifecycleExecutionOptions,
  ) => Promise<BulkPublishResult>;
  previewBulkEdit: (
    selection: BulkSelection<CatalogItemListParams>,
    operation: BulkEditCatalogItemOperation,
  ) => Promise<BulkEditCatalogItemPreview>;
  editBulk: (
    selection: BulkSelection<CatalogItemListParams>,
    operation: BulkEditCatalogItemOperation,
    context: EventStoreContext,
    options?: BulkLifecycleExecutionOptions,
  ) => Promise<BulkEditCatalogItemResult>;
  processDisplayIdentityRecomputeBatch: (
    context: EventStoreContext,
    options?: Readonly<{ limit?: number }>,
  ) => Promise<DisplayIdentityRecomputeBatchResult>;
  getDisplayIdentityRecomputeHealth: () => Promise<DisplayIdentityRecomputeHealth>;
  purgeCompletedDisplayIdentityRecomputeWork: (options?: DisplayIdentityRecomputeRetentionOptions) => Promise<number>;
  bulkLifecycle: BulkLifecycleOperations<CatalogItemListParams, CatalogItemCommand, CatalogItemState, CatalogItemEvent>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCatalogItemRuntime(deps: CatalogRuntimeDeps): CatalogItemServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CatalogItemEvent>(),
    initialState: () => initialCatalogItemState,
    evolve: evolveCatalogItem,
    decide: decideCatalogItem,
  });

  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-item-projection",
      handlers: buildCatalogItemProjectionHandlers(deps.db),
    }),
    createProjectionHandlerSet({
      projectionName: "catalog-admin-catalog-item-projection",
      handlers: withCatalogAdminRealtimeInvalidation(buildCatalogAdminCatalogItemProjectionHandlers(deps.db), deps.db, {
        projectionName: "catalog-admin-catalog-item-projection",
        surface: "catalog-items",
      }),
    }),
  ];
  const bulkLifecycle = createBulkLifecycleOperations<
    CatalogItemListParams,
    CatalogItemCommand,
    CatalogItemState,
    CatalogItemEvent
  >({
    actions: [
      {
        action: "archive",
        readyStatus: "active",
        command: { type: "ArchiveCatalogItem" },
        streamId: (id) => `catalog.item-${id}`,
        blockedReason: (status) => `Only active Catalog Items can be archived. Current status: ${status}.`,
      },
    ],
    commandHandler,
    resolveIds: (selection: BulkSelection<CatalogItemListParams>) =>
      selection.mode === "ids" ? Promise.resolve(selection.ids) : listCatalogItemIds(deps.db, selection.query),
    loadRows: (ids) => listCatalogItemBulkRows(deps.db, ids),
  });

  return {
    commandHandler,
    listCatalogItems: (params) => listCatalogItems(deps.db, params),
    getCatalogItemDetail: (itemId) => getCatalogItemDetail(deps.db, itemId),
    getCatalogItemByGtin: (gtin) => getCatalogItemByGtin(deps.db, gtin),
    previewBulkPublish: async (selection) => previewBulkPublish(deps, selection),
    publishBulk: async (itemIds, context, options) => publishBulk(deps, commandHandler, itemIds, context, options),
    previewBulkEdit: async (selection, operation) => previewBulkEdit(deps, selection, operation),
    editBulk: async (selection, operation, context, options) =>
      editBulk(deps, commandHandler, selection, operation, context, options),
    processDisplayIdentityRecomputeBatch: async (context, options) =>
      processCatalogItemDisplayIdentityRecomputeBatch(deps.db, commandHandler, context, {
        ...options,
        afterPersist: (itemId) => refreshCatalogAdminCatalogItemPages(deps.db, itemId),
      }),
    getDisplayIdentityRecomputeHealth: async () => getCatalogItemDisplayIdentityRecomputeHealth(deps.db),
    purgeCompletedDisplayIdentityRecomputeWork: async (options) =>
      purgeCompletedCatalogItemDisplayIdentityRecomputeWork(deps.db, options),
    bulkLifecycle,
    projectors,
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
  options: BulkLifecycleExecutionOptions = {},
): Promise<BulkPublishResult> {
  const normalizedIds = normalizeRequestedItemIds(itemIds);
  const preview = await classifyBulkPublishCandidates(deps, normalizedIds);
  const results: BulkPublishCandidate[] = [];
  let completed = 0;

  for (const candidate of preview) {
    options.throwIfCancelled?.();
    if (candidate.outcome !== "ready") {
      results.push({ ...candidate, outcome: "skipped" });
      completed += 1;
      await options.onProgress?.({
        completed,
        total: preview.length,
        currentName: candidate.title,
        status: "skipped",
      });
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
      completed += 1;
      await options.onProgress?.({
        completed,
        total: preview.length,
        currentName: candidate.title,
        status: "succeeded",
      });
    } catch (error) {
      results.push({
        ...candidate,
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      completed += 1;
      await options.onProgress?.({
        completed,
        total: preview.length,
        currentName: candidate.title,
        status: "failed",
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

async function resolveBulkPublishItemIds(deps: CatalogRuntimeDeps, selection: BulkPublishSelection): Promise<string[]> {
  if (selection.mode === "ids") {
    return normalizeRequestedItemIds(selection.ids);
  }

  return listCatalogItemIdsForBulkPublishFilter(deps.db, selection.query);
}

function normalizeRequestedItemIds(itemIds: readonly string[]): string[] {
  const normalized = Array.from(new Set(itemIds.map((itemId) => itemId.trim()).filter(Boolean)));

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

async function previewBulkEdit(
  deps: CatalogRuntimeDeps,
  selection: BulkSelection<CatalogItemListParams>,
  operation: BulkEditCatalogItemOperation,
): Promise<BulkEditCatalogItemPreview> {
  const normalizedOperation = normalizeBulkEditOperation(operation);
  const itemIds = await resolveBulkEditItemIds(deps, selection);
  const candidates = await classifyBulkEditCandidates(deps, itemIds, normalizedOperation);
  const readyCount = candidates.filter((candidate) => candidate.outcome === "ready").length;

  return {
    mode: selection.mode,
    action: normalizedOperation.action,
    item_ids: itemIds,
    total: candidates.length,
    ready_count: readyCount,
    blocked_count: candidates.length - readyCount,
    candidates,
  };
}

async function editBulk(
  deps: CatalogRuntimeDeps,
  commandHandler: CatalogItemServices["commandHandler"],
  selection: BulkSelection<CatalogItemListParams>,
  operation: BulkEditCatalogItemOperation,
  context: EventStoreContext,
  options: BulkLifecycleExecutionOptions = {},
): Promise<BulkEditCatalogItemResult> {
  const normalizedOperation = normalizeBulkEditOperation(operation);
  const itemIds = await resolveBulkEditItemIds(deps, selection);
  const preview = await classifyBulkEditCandidates(deps, itemIds, normalizedOperation);
  const candidates: BulkEditCatalogItemCandidate[] = [];
  let completed = 0;

  for (const candidate of preview) {
    options.throwIfCancelled?.();
    if (candidate.outcome !== "ready") {
      candidates.push({ ...candidate, outcome: "skipped" });
      completed += 1;
      await options.onProgress?.({
        completed,
        total: preview.length,
        currentName: candidate.title,
        status: "skipped",
      });
      continue;
    }

    try {
      const result = await commandHandler({
        streamId: `catalog.item-${candidate.catalog_item_id}`,
        command: commandForBulkEdit(candidate, normalizedOperation),
        context,
      });

      candidates.push({
        ...candidate,
        status: result.state.status,
        blueprint_id: result.state.blueprintId,
        category_ids: result.state.categoryIds,
        tags: result.state.tags,
        outcome: "succeeded",
        reason: null,
      });
      completed += 1;
      await options.onProgress?.({
        completed,
        total: preview.length,
        currentName: candidate.title,
        status: "succeeded",
      });
    } catch (error) {
      candidates.push({
        ...candidate,
        outcome: "failed",
        reason: error instanceof Error ? error.message : "Bulk edit failed.",
      });
      completed += 1;
      await options.onProgress?.({
        completed,
        total: preview.length,
        currentName: candidate.title,
        status: "failed",
      });
    }
  }

  return {
    action: normalizedOperation.action,
    item_ids: itemIds,
    total: candidates.length,
    succeeded_count: candidates.filter((candidate) => candidate.outcome === "succeeded").length,
    skipped_count: candidates.filter((candidate) => candidate.outcome === "skipped").length,
    failed_count: candidates.filter((candidate) => candidate.outcome === "failed").length,
    candidates,
  };
}

async function resolveBulkEditItemIds(
  deps: CatalogRuntimeDeps,
  selection: BulkSelection<CatalogItemListParams>,
): Promise<string[]> {
  const itemIds = selection.mode === "ids" ? selection.ids : await listCatalogItemIds(deps.db, selection.query);

  return normalizeRequestedBulkEditItemIds(itemIds);
}

async function classifyBulkEditCandidates(
  deps: CatalogRuntimeDeps,
  itemIds: readonly string[],
  operation: BulkEditCatalogItemOperation,
): Promise<BulkEditCatalogItemCandidate[]> {
  const rows = await listCatalogItemsForBulkEdit(deps.db, itemIds);
  const byId = new Map(rows.map((row) => [row.catalog_item_id, row]));

  return itemIds.map((itemId) => {
    const row = byId.get(itemId);

    if (!row) {
      return {
        catalog_item_id: itemId,
        title: itemId,
        status: "missing",
        blueprint_id: null,
        category_ids: [],
        tags: [],
        outcome: "blocked",
        reason: "Catalog Item was not found.",
      };
    }

    return classifyBulkEditCandidate(row, operation);
  });
}

function classifyBulkEditCandidate(
  row: BulkEditCatalogItemRow,
  operation: BulkEditCatalogItemOperation,
): BulkEditCatalogItemCandidate {
  const candidate = {
    catalog_item_id: row.catalog_item_id,
    title: row.title,
    status: row.status,
    blueprint_id: row.blueprint_id,
    category_ids: asStringArray(row.category_ids),
    tags: normalizeTags(asStringArray(row.tags)),
  };
  const reason = bulkEditBlockedReason(candidate, operation);

  return {
    ...candidate,
    outcome: reason ? "blocked" : "ready",
    reason,
  };
}

function bulkEditBlockedReason(
  candidate: Omit<BulkEditCatalogItemCandidate, "outcome" | "reason">,
  operation: BulkEditCatalogItemOperation,
): string | null {
  if (operation.action === "assignBlueprint") {
    if (candidate.status !== "draft") {
      return `Blueprint assignment only applies to draft Catalog Items. Current status: ${candidate.status}.`;
    }

    return candidate.blueprint_id === operation.blueprintId ? "Catalog Item already uses that blueprint." : null;
  }

  if (candidate.status === "archived") {
    return "Archived Catalog Items cannot be modified.";
  }

  if (operation.action === "assignCategory") {
    return candidate.category_ids.includes(operation.categoryId)
      ? "Catalog Item already belongs to that category."
      : null;
  }

  if (operation.action === "removeCategory") {
    return candidate.category_ids.includes(operation.categoryId)
      ? null
      : "Catalog Item does not belong to that category.";
  }

  if (operation.action === "clearTags") {
    return candidate.tags.length > 0 ? null : "Catalog Item already has no tags.";
  }

  const nextTags = tagsForBulkEdit(candidate.tags, operation);
  return arraysEqual(candidate.tags, nextTags) ? "Catalog Item already has those tags." : null;
}

function commandForBulkEdit(
  candidate: BulkEditCatalogItemCandidate,
  operation: BulkEditCatalogItemOperation,
): CatalogItemCommand {
  switch (operation.action) {
    case "assignBlueprint":
      return {
        type: "AssignBlueprintToCatalogItem",
        blueprintId: operation.blueprintId as BlueprintId,
      };
    case "assignCategory":
      return {
        type: "AssignCatalogItemToCategory",
        categoryId: operation.categoryId as CategoryId,
      };
    case "removeCategory":
      return {
        type: "RemoveCatalogItemFromCategory",
        categoryId: operation.categoryId as CategoryId,
      };
    case "setTags":
    case "mergeTags":
    case "clearTags":
      return {
        type: "SetCatalogItemTags",
        tags: tagsForBulkEdit(candidate.tags, operation),
      };
    default:
      throw new CatalogDomainError("Unknown Catalog Item bulk edit action.");
  }
}

function normalizeBulkEditOperation(operation: BulkEditCatalogItemOperation): BulkEditCatalogItemOperation {
  switch (operation.action) {
    case "assignBlueprint": {
      const blueprintId = operation.blueprintId.trim();
      if (!blueprintId) {
        throw new CatalogDomainError("Bulk blueprint assignment requires a blueprint ID.");
      }

      return { action: operation.action, blueprintId };
    }
    case "assignCategory":
    case "removeCategory": {
      const categoryId = operation.categoryId.trim();
      if (!categoryId) {
        throw new CatalogDomainError("Bulk category edits require a category ID.");
      }

      return { action: operation.action, categoryId };
    }
    case "setTags":
    case "mergeTags": {
      const tags = normalizeTags(operation.tags);
      if (tags.length === 0) {
        throw new CatalogDomainError("Bulk tag edits require at least one tag.");
      }

      return { action: operation.action, tags };
    }
    case "clearTags":
      return operation;
    default:
      throw new CatalogDomainError("Unknown Catalog Item bulk edit action.");
  }
}

function tagsForBulkEdit(currentTags: readonly string[], operation: BulkEditCatalogItemOperation): string[] {
  if (operation.action === "clearTags") {
    return [];
  }

  if (operation.action === "mergeTags") {
    return normalizeTags([...currentTags, ...operation.tags]);
  }

  if (operation.action === "setTags") {
    return normalizeTags(operation.tags);
  }

  return normalizeTags(currentTags);
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeRequestedBulkEditItemIds(itemIds: readonly string[]): string[] {
  const normalized = Array.from(new Set(itemIds.map((itemId) => itemId.trim()).filter(Boolean)));

  if (normalized.length === 0) {
    throw new CatalogDomainError("Choose at least one Catalog Item to edit.");
  }

  return normalized;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
