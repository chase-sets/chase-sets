import type { ResolvedActor } from "@chase-sets/auth-context";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { coerceLocalizedTextMap } from "@chase-sets/localization";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { z } from "zod";
import type { CatalogItemId } from "../../../ids";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import type { CatalogItemCommand } from "../domain/domain";
import { catalogItemListQueryFromRecord, toExpectedVersion, toImageFallback } from "./route";
import {
  CatalogItemPublicationError,
  CatalogItemPublicationPreconditionError,
  type CatalogItemServices,
} from "./runtime";

const itemId = z.string().transform((value) => parseTypedIdBoundary(value, "cat", "catalogItemId"));
const blueprintId = z.string().transform((value) => parseTypedIdBoundary(value, "bpr", "blueprintId"));
const categoryId = z.string().transform((value) => parseTypedIdBoundary(value, "ctg", "categoryId"));
const fieldId = z.string().transform((value) => parseTypedIdBoundary(value, "fld", "fieldId"));
const localizedText = z.strictObject({ defaultLocale: z.string(), values: z.record(z.string(), z.string()) });
const query = z.strictObject({
  search: z.string().optional(),
  status: z.string().optional(),
  blueprintId: z.string().optional(),
  tag: z.string().optional(),
  language: z.string().optional(),
  source: z.string().optional(),
  blueprintState: z.string().optional(),
  hasImages: z.string().optional(),
  hasSourceReferences: z.string().optional(),
  missingRequiredFields: z.string().optional(),
});
const selection = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("ids"), ids: z.array(itemId).min(1) }),
    z.strictObject({ mode: z.literal("filter"), query }),
  ])
  .transform((input) =>
    input.mode === "ids" ? input : { ...input, query: catalogItemListQueryFromRecord(input.query) },
  );
const operation = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("assignBlueprint"), blueprintId }),
  z.strictObject({ action: z.enum(["assignCategory", "removeCategory"]), categoryId }),
  z.strictObject({ action: z.enum(["setTags", "mergeTags"]), tags: z.array(z.string()) }),
  z.strictObject({ action: z.literal("clearTags") }),
]);
const bulkEdit = z.strictObject({ selection, operation });
const bulkLifecycle = z.strictObject({ selection, action: z.literal("archive") });
const write = {
  idempotencyKey: z.string().trim().min(1),
  confirmed: z.literal(true),
  confirmationText: z.string(),
};
const item = z.strictObject({ catalogItemId: itemId });
const itemWrite = item.extend(write);
const metadata = itemWrite.extend({
  languageCode: z.string().optional(),
  title: localizedText,
  subtitle: localizedText.nullable(),
  description: localizedText.optional(),
});
const externalReference = itemWrite.extend({ providerKey: z.string(), externalKey: z.string() });
const publish = itemWrite.extend({
  expectedVersion: z
    .union([z.number(), z.enum(["any", "no_stream"])])
    .optional()
    .transform(toExpectedVersion),
  blueprintIsActive: z.boolean().optional(),
  requiredFieldIds: z.array(fieldId).optional(),
});

function operator(actor: ResolvedActor | null, permission: "catalog.view" | "catalog.manage"): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required operator permission: ${permission}.`);
  }
  return actor;
}

export function createCatalogItemMcpHandlers(
  services: CatalogItemServices,
  authoringJobs: Pick<CatalogAuthoringBulkJobServices, "enqueue">,
): Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }> {
  function command<
    S extends z.ZodType<{
      catalogItemId: CatalogItemId;
      expectedVersion?: z.output<typeof publish>["expectedVersion"];
    }>,
  >(schema: S, build: (input: z.output<S>) => CatalogItemCommand): McpToolHandler {
    return async ({ actor, arguments: args }) => {
      const scoped = operator(actor, "catalog.manage");
      const input = schema.parse(args);
      const { catalogItemId, expectedVersion } = input;
      try {
        const result = await services.commandHandler({
          streamId: `catalog.item-${catalogItemId}`,
          command: build(input),
          context: createActorEventStoreContext(scoped),
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        return commandSnapshotResponse(catalogItemId, result);
      } catch (error) {
        if (error instanceof CatalogItemPublicationError) {
          throw new Error(`${error.code}: ${error.message} Missing tokens: ${error.missingTokens.join(", ")}`, {
            cause: error,
          });
        }
        if (error instanceof CatalogItemPublicationPreconditionError) {
          throw new Error(`${error.code}: ${error.message} Missing fields: ${error.missingFieldIds.join(", ")}`, {
            cause: error,
          });
        }
        throw error;
      }
    };
  }

  return {
    toolHandlers: {
      "catalog.search-items": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        const input = query.extend({ limit: z.int().optional(), offset: z.int().optional() }).parse(args);
        const result = await services.listCatalogItems({
          ...input,
          limit: input.limit || undefined,
          offset: input.offset || undefined,
        });
        return { ...result, count: result.items.length };
      },
      "catalog.get-item": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        const { catalogItemId } = item.parse(args);
        const result = await services.getCatalogItemDetail(catalogItemId);
        if (!result) throw new Error("Catalog Item not found.");
        return result;
      },
      "catalog.create-item": command(metadata.extend({ subtitle: localizedText.nullable().optional() }), (input) => ({
        type: "CreateCatalogItem",
        itemId: input.catalogItemId,
        languageCode: input.languageCode,
        title: coerceLocalizedTextMap(input.title),
        subtitle: input.subtitle ? coerceLocalizedTextMap(input.subtitle) : null,
        description: coerceLocalizedTextMap(input.description ?? ""),
      })),
      "catalog.revise-item-metadata": command(metadata, (input) => ({
        type: "ReviseCatalogItemMetadata",
        languageCode: input.languageCode,
        title: coerceLocalizedTextMap(input.title),
        subtitle: input.subtitle === null ? null : coerceLocalizedTextMap(input.subtitle),
        description: input.description === undefined ? undefined : coerceLocalizedTextMap(input.description),
      })),
      "catalog.assign-blueprint": command(itemWrite.extend({ blueprintId }), (input) => ({
        type: "AssignBlueprintToCatalogItem",
        blueprintId: input.blueprintId,
      })),
      "catalog.assign-category": command(itemWrite.extend({ categoryId }), (input) => ({
        type: "AssignCatalogItemToCategory",
        categoryId: input.categoryId,
      })),
      "catalog.remove-category": command(itemWrite.extend({ categoryId }), (input) => ({
        type: "RemoveCatalogItemFromCategory",
        categoryId: input.categoryId,
      })),
      "catalog.set-field-value": command(itemWrite.extend({ fieldId, value: z.json() }), (input) => ({
        type: "SetCatalogItemFieldValue",
        fieldId: input.fieldId,
        value: input.value,
      })),
      "catalog.clear-field-value": command(
        itemWrite.extend({ fieldId, requiredFieldIds: z.array(fieldId).optional() }),
        (input) => ({
          type: "ClearCatalogItemFieldValue",
          fieldId: input.fieldId,
          requiredFieldIds: input.requiredFieldIds,
        }),
      ),
      "catalog.set-tags": command(itemWrite.extend({ tags: z.array(z.string()) }), (input) => ({
        type: "SetCatalogItemTags",
        tags: input.tags,
      })),
      "catalog.set-image-urls": command(itemWrite.extend({ imageUrls: z.array(z.string()) }), (input) => ({
        type: "SetCatalogItemImageUrls",
        imageUrls: input.imageUrls,
      })),
      "catalog.set-image-fallback": command(
        itemWrite.extend({
          imageFallback: z.strictObject({
            url: z.string(),
            alt: z.string(),
            usage: z.enum(["permanent", "loading-only"]),
            variants: z.record(
              z.string(),
              z.strictObject({ oneX: z.string().optional(), twoX: z.string().optional() }),
            ),
          }),
        }),
        (input) => ({
          type: "SetCatalogItemImageFallback",
          imageFallback: toImageFallback(input.imageFallback),
        }),
      ),
      "catalog.clear-image-fallback": command(itemWrite, () => ({ type: "ClearCatalogItemImageFallback" })),
      "catalog.link-external-catalog-item-reference": command(externalReference, ({ providerKey, externalKey }) => ({
        type: "LinkExternalCatalogItemReference",
        providerKey,
        externalKey,
      })),
      "catalog.unlink-external-catalog-item-reference": command(externalReference, ({ providerKey, externalKey }) => ({
        type: "UnlinkExternalCatalogItemReference",
        providerKey,
        externalKey,
      })),
      "catalog.link-external-product-reference": command(
        externalReference.extend({
          selectedOptions: z.array(z.strictObject({ dimensionId: z.string(), optionId: z.string() })),
        }),
        ({ providerKey, externalKey, selectedOptions }) => ({
          type: "LinkExternalProductReference",
          providerKey,
          externalKey,
          selectedOptions,
        }),
      ),
      "catalog.unlink-external-product-reference": command(externalReference, ({ providerKey, externalKey }) => ({
        type: "UnlinkExternalProductReference",
        providerKey,
        externalKey,
      })),
      // Publication hints from the frozen contract are not authority; the owning service resolves readiness.
      "catalog.publish-item": command(publish, () => ({ type: "PublishCatalogItem" })),
      "catalog.archive-item": command(itemWrite, () => ({ type: "ArchiveCatalogItem" })),
      "catalog.remove-draft-item": command(itemWrite, () => ({ type: "RemoveDraftCatalogItem" })),
      "catalog.preview-bulk-publish-catalog-items": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.manage");
        return services.previewBulkPublish(z.strictObject({ selection }).parse(args).selection);
      },
      "catalog.confirm-bulk-publish-catalog-items": async ({ actor, arguments: args }) => {
        const scoped = operator(actor, "catalog.manage");
        const { itemIds } = z.strictObject({ itemIds: z.array(itemId).min(1), ...write }).parse(args);
        return authoringJobs.enqueue({
          kind: "catalog.authoring.items.publish",
          action: "publish",
          itemIds,
          context: createActorEventStoreContext(scoped),
        });
      },
      "catalog.preview-bulk-catalog-item-lifecycle": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.manage");
        const input = bulkLifecycle.parse(args);
        return services.bulkLifecycle.preview(input.selection, input.action);
      },
      "catalog.confirm-bulk-catalog-item-lifecycle": async ({ actor, arguments: args }) => {
        const scoped = operator(actor, "catalog.manage");
        const input = bulkLifecycle.extend(write).parse(args);
        return authoringJobs.enqueue({
          kind: "catalog.authoring.items.lifecycle",
          action: input.action,
          selection: input.selection,
          context: createActorEventStoreContext(scoped),
        });
      },
      "catalog.preview-bulk-catalog-item-edit": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.manage");
        const input = bulkEdit.parse(args);
        return services.previewBulkEdit(input.selection, input.operation);
      },
      "catalog.confirm-bulk-catalog-item-edit": async ({ actor, arguments: args }) => {
        const scoped = operator(actor, "catalog.manage");
        const input = bulkEdit.extend(write).parse(args);
        return authoringJobs.enqueue({
          kind: "catalog.authoring.items.edit",
          action: input.operation.action,
          selection: input.selection,
          operation: input.operation,
          context: createActorEventStoreContext(scoped),
        });
      },
    },
  };
}
