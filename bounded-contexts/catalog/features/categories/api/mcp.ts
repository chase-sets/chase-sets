import type { ResolvedActor } from "@chase-sets/auth-context";
import { parseOptionalTypedIdBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { coerceLocalizedTextMap } from "@chase-sets/localization";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { z } from "zod";
import type { CategoryId } from "../../../ids";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";
import type { CategoryCommand } from "../domain/domain";
import type { CategoryListRow } from "../read-model/queries";
import type { CategoryServices } from "./runtime";

const categoryId = z.string().transform((value) => parseTypedIdBoundary(value, "ctg", "categoryId"));
const localizedText = z.strictObject({ defaultLocale: z.string(), values: z.record(z.string(), z.string()) });
const query = z.strictObject({
  search: z.string().optional(),
  status: z.string().optional(),
  parentCategoryId: z.string().optional(),
  hierarchy: z.string().optional(),
});
const selection = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("ids"), ids: z.array(categoryId) }),
  z.strictObject({ mode: z.literal("filter"), query }),
]);
const bulk = z.strictObject({ action: z.enum(["publish", "deprecate", "archive"]), selection });
const write = {
  idempotencyKey: z.string().trim().min(1),
  confirmed: z.boolean().optional(),
  confirmationText: z.string(),
};
const lifecycleInput = z.strictObject({ categoryId, ...write });
const metadataInput = lifecycleInput.extend({
  key: z.string(),
  name: localizedText,
  displayOrder: z.int32().optional(),
});
const parentCategoryId = z.string().nullable();
const createInput = metadataInput.extend({
  description: localizedText.optional(),
  parentCategoryId: parentCategoryId
    .optional()
    .transform((value) => parseOptionalTypedIdBoundary(value, "ctg", "parentCategoryId")),
});
const reviseInput = metadataInput.extend({
  description: localizedText,
  parentCategoryId: parentCategoryId.transform((value) =>
    value === null ? null : parseTypedIdBoundary(value, "ctg", "parentCategoryId"),
  ),
});

function operator(actor: ResolvedActor | null, permission: string): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required operator permission: ${permission}.`);
  }
  return actor;
}

function categoryMetadata(input: z.output<typeof createInput> | z.output<typeof reviseInput>) {
  return {
    key: input.key,
    name: coerceLocalizedTextMap(input.name),
    parentCategoryId: input.parentCategoryId,
    displayOrder: input.displayOrder,
  };
}

function categorySnapshot(row: CategoryListRow, counts: ReadonlyMap<string, number>) {
  return {
    id: row.category_id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    itemCount: counts.get(row.category_id) ?? 0,
    nameI18n: row.name_i18n,
    descriptionI18n: row.description_i18n,
    parentCategoryId: row.parent_category_id,
    parentCategory: row.parent_category,
    displayOrder: row.display_order,
    updatedAt: row.updated_at,
  };
}

export function createCategoryMcpHandlers(
  services: CategoryServices,
  authoringJobs: Pick<CatalogAuthoringBulkJobServices, "enqueue">,
): Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }> {
  function command<S extends z.ZodType<{ categoryId: CategoryId }>>(
    schema: S,
    build: (input: z.output<S>) => CategoryCommand,
  ): McpToolHandler {
    return async ({ actor, arguments: args }) => {
      const scoped = operator(actor, "catalog.manage");
      const input = schema.parse(args);
      const result = await services.commandHandler({
        streamId: `catalog.category-${input.categoryId}`,
        command: build(input),
        context: createActorEventStoreContext(scoped),
      });
      return commandSnapshotResponse(input.categoryId, result);
    };
  }

  return {
    toolHandlers: {
      "catalog.create-category": command(createInput, (input) => ({
        type: "CreateCategory",
        categoryId: input.categoryId,
        ...categoryMetadata(input),
        description: coerceLocalizedTextMap(input.description ?? ""),
      })),
      "catalog.revise-category": command(reviseInput, (input) => ({
        type: "ReviseCategory",
        ...categoryMetadata(input),
        description: coerceLocalizedTextMap(input.description),
      })),
      "catalog.publish-category": command(lifecycleInput, () => ({ type: "PublishCategory" })),
      "catalog.deprecate-category": command(lifecycleInput, () => ({ type: "DeprecateCategory" })),
      "catalog.archive-category": command(lifecycleInput, () => ({ type: "ArchiveCategory" })),
      "catalog.list-categories": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        const input = query.extend({ limit: z.number().optional(), offset: z.number().optional() }).parse(args);
        const result = await services.listCategories({
          ...input,
          limit: input.limit || undefined,
          offset: input.offset || undefined,
        });
        const counts = await services.getCategoryItemCounts(result.items.map((row) => row.category_id));
        return {
          items: result.items.map((row) => categorySnapshot(row, counts)),
          total: result.total,
          count: result.items.length,
        };
      },
      "catalog.get-category": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        const input = z.strictObject({ categoryId }).parse(args);
        const row = await services.getCategoryDetail(input.categoryId);
        if (!row) throw new Error("Category not found.");
        return categorySnapshot(row, await services.getCategoryItemCounts([row.category_id]));
      },
      "catalog.preview-bulk-category-lifecycle": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.manage");
        const input = bulk.parse(args);
        const preview = await services.bulkLifecycle.preview(await resolveSelection(input.selection), input.action);
        return { ...preview, mode: input.selection.mode };
      },
      "catalog.confirm-bulk-category-lifecycle": async ({ actor, arguments: args }) => {
        const scoped = operator(actor, "catalog.manage");
        const input = bulk.extend(write).parse(args);
        return authoringJobs.enqueue({
          kind: "catalog.authoring.categories.lifecycle",
          action: input.action,
          selection: await resolveSelection(input.selection),
          context: createActorEventStoreContext(scoped),
        });
      },
    },
  };

  async function resolveSelection(value: z.output<typeof selection>) {
    const normalized = normalizeBulkSelection(value, (record) => ({
      search: toOptionalString(record.search),
      status: toOptionalString(record.status),
      parentCategoryId: toOptionalString(record.parentCategoryId),
      hierarchy: toOptionalString(record.hierarchy),
    }));
    if (normalized.mode === "ids") return normalized;

    // Resolve every page before invoking a bulk operation; the HTTP resolver uses one default page.
    const ids = new Set<string>();
    let expectedTotal: number | undefined;
    for (let offset = 0; offset <= 10_000; offset += 500) {
      const page = await services.listCategories({ ...normalized.query, limit: 500, offset });
      expectedTotal ??= page.total;
      if (page.total !== expectedTotal || expectedTotal > 10_500) break;
      if (page.items.length !== Math.min(500, expectedTotal - offset)) break;
      for (const row of page.items) ids.add(row.category_id);
      if (ids.size !== offset + page.items.length) break;
      if (ids.size === expectedTotal) return { mode: "ids" as const, ids: [...ids] };
    }
    throw new Error("Category selection is incomplete or changed while paging; use explicit ids or a narrower filter.");
  }
}
