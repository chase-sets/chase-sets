import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdArrayBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { BulkEditCatalogItemOperation, BulkPublishSelection, CatalogItemServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { CatalogDomainError, type LocalizedTextMap } from "../../../support/runtime-support/common";
import type { CatalogItemImageFallback } from "../domain/domain";
import {
  normalizeBulkSelection,
  toOptionalString as optionalStringFromBulk,
} from "../../../support/runtime-support/bulk-lifecycle";

export function catalogItemRoutes(services: CatalogItemServices, authoringBulkJobs: CatalogAuthoringBulkJobServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const itemId = parseTypedIdBoundary(body.itemId, "cat", "itemId");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "CreateCatalogItem",
        itemId,
        languageCode: body.languageCode,
        title: toLocalizedTextMap(body.title),
        subtitle: body.subtitle ? toLocalizedTextMap(body.subtitle) : null,
        description: toLocalizedTextMap(body.description ?? ""),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result), 201);
  });

  app.post("/bulk-publish/preview", async (c) => {
    const body = await c.req.json();
    const result = await services.previewBulkPublish(toBulkPublishSelection(body.selection));
    return c.json(result);
  });

  app.post("/bulk-publish/confirm", async (c) => {
    const body = await c.req.json();
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.items.publish",
      action: "publish",
      itemIds: toStringArray(body.itemIds),
      context: c.get("context"),
    });
    return c.json(result, 202);
  });

  app.post("/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.bulkLifecycle.preview(
      normalizeBulkSelection(body.selection, catalogItemListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.items.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, catalogItemListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.post("/bulk-edit/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.previewBulkEdit(
      normalizeBulkSelection(body.selection, catalogItemListQueryFromRecord),
      toBulkEditOperation(body.operation),
    );

    return c.json(result);
  });

  app.post("/bulk-edit/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const operation = toBulkEditOperation(body.operation);
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.items.edit",
      action: operation.action,
      selection: normalizeBulkSelection(body.selection, catalogItemListQueryFromRecord),
      operation,
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.post("/:id/blueprint", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "AssignBlueprintToCatalogItem",
        blueprintId: parseTypedIdBoundary(body.blueprintId, "bpr", "blueprintId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/fields/:fieldId", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "SetCatalogItemFieldValue",
        fieldId: parseTypedIdBoundary(c.req.param("fieldId"), "fld", "fieldId"),
        value: body.value,
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.delete("/:id/fields/:fieldId", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "ClearCatalogItemFieldValue",
        fieldId: parseTypedIdBoundary(c.req.param("fieldId"), "fld", "fieldId"),
        requiredFieldIds:
          body.requiredFieldIds === undefined
            ? undefined
            : parseTypedIdArrayBoundary(body.requiredFieldIds, "fld", "requiredFieldIds"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.post("/:id/categories/:categoryId", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "AssignCatalogItemToCategory",
        categoryId: parseTypedIdBoundary(c.req.param("categoryId"), "ctg", "categoryId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result), 201);
  });

  app.delete("/:id/categories/:categoryId", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "RemoveCatalogItemFromCategory",
        categoryId: parseTypedIdBoundary(c.req.param("categoryId"), "ctg", "categoryId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.post("/:id/publish", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "PublishCatalogItem",
        blueprintIsActive: body.blueprintIsActive,
        requiredFieldIds: parseTypedIdArrayBoundary(body.requiredFieldIds, "fld", "requiredFieldIds"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/metadata", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "ReviseCatalogItemMetadata",
        languageCode: body.languageCode,
        title: toLocalizedTextMap(body.title),
        subtitle: body.subtitle ? toLocalizedTextMap(body.subtitle) : null,
        description: body.description === undefined ? undefined : toLocalizedTextMap(body.description),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/tags", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "SetCatalogItemTags",
        tags: body.tags,
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/image-urls", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "SetCatalogItemImageUrls",
        imageUrls: body.imageUrls,
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/image-fallback", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "SetCatalogItemImageFallback",
        imageFallback: toImageFallback(body.imageFallback ?? body),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.delete("/:id/image-fallback", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "ClearCatalogItemImageFallback",
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/external-product-references/:providerKey/:externalKey", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "LinkExternalProductReference",
        providerKey: c.req.param("providerKey"),
        externalKey: c.req.param("externalKey"),
        selectedOptions: Array.isArray(body.selectedOptions) ? body.selectedOptions : [],
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/external-catalog-item-references/:providerKey/:externalKey", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "LinkExternalCatalogItemReference",
        providerKey: c.req.param("providerKey"),
        externalKey: c.req.param("externalKey"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.delete("/:id/external-product-references/:providerKey/:externalKey", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "UnlinkExternalProductReference",
        providerKey: c.req.param("providerKey"),
        externalKey: c.req.param("externalKey"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.delete("/:id/external-catalog-item-references/:providerKey/:externalKey", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "UnlinkExternalCatalogItemReference",
        providerKey: c.req.param("providerKey"),
        externalKey: c.req.param("externalKey"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.put("/:id/gtins/:gtin", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "LinkCatalogItemGtin",
        gtin: c.req.param("gtin"),
        productForm: typeof body.productForm === "string" ? body.productForm : null,
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.delete("/:id/gtins/:gtin", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "UnlinkCatalogItemGtin",
        gtin: c.req.param("gtin"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.post("/:id/archive", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: { type: "ArchiveCatalogItem" },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.delete("/:id", async (c) => {
    const itemId = parseTypedIdBoundary(c.req.param("id"), "cat", "itemId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: { type: "RemoveDraftCatalogItem" },
      context,
    });

    return c.json(commandSnapshotResponse(itemId, result));
  });

  app.get("/", async (c) => {
    const {
      search,
      status,
      limit,
      offset,
      blueprintId,
      tag,
      language,
      source,
      blueprintState,
      hasImages,
      hasSourceReferences,
      missingRequiredFields,
    } = c.req.query();
    const result = await services.listCatalogItems({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
      blueprintId,
      tag,
      language,
      source,
      blueprintState,
      hasImages,
      hasSourceReferences,
      missingRequiredFields,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/gtin-lookup/:gtin", async (c) => {
    const result = await services.getCatalogItemByGtin(c.req.param("gtin"));

    if (!result) {
      return c.json(
        { error: { code: "not_found", message: t("catalog.features.catalogItems.api.route.gtin.was.not.found") } },
        404,
      );
    }

    return c.json(result);
  });

  app.get("/:id", async (c) => {
    const item = await services.getCatalogItemDetail(c.req.param("id"));

    if (!item) {
      return c.json(
        { error: { code: "not_found", message: t("catalog.features.catalogItems.api.route.catalog.item.not.found") } },
        404,
      );
    }

    return c.json(item);
  });

  return app;
}

function catalogItemListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: optionalStringFromBulk(record.search),
    status: optionalStringFromBulk(record.status),
    blueprintId: optionalStringFromBulk(record.blueprintId),
    tag: optionalStringFromBulk(record.tag),
    language: optionalStringFromBulk(record.language),
    source: optionalStringFromBulk(record.source),
    blueprintState: optionalStringFromBulk(record.blueprintState),
    hasImages: optionalStringFromBulk(record.hasImages),
    hasSourceReferences: optionalStringFromBulk(record.hasSourceReferences),
    missingRequiredFields: optionalStringFromBulk(record.missingRequiredFields),
  };
}

function toBulkPublishSelection(value: unknown): BulkPublishSelection {
  if (!value || typeof value !== "object") {
    return { mode: "ids", ids: [] };
  }

  const selection = value as { mode?: unknown; ids?: unknown; query?: unknown };

  if (selection.mode === "filter") {
    const query =
      selection.query && typeof selection.query === "object" ? (selection.query as Record<string, unknown>) : {};

    return {
      mode: "filter",
      query: {
        search: toOptionalString(query.search),
        status: toOptionalString(query.status),
        blueprintId: toOptionalString(query.blueprintId),
        tag: toOptionalString(query.tag),
        language: toOptionalString(query.language),
        source: toOptionalString(query.source),
        blueprintState: toOptionalString(query.blueprintState),
        hasImages: toOptionalString(query.hasImages),
        hasSourceReferences: toOptionalString(query.hasSourceReferences),
        missingRequiredFields: toOptionalString(query.missingRequiredFields),
      },
    };
  }

  return { mode: "ids", ids: toStringArray(selection.ids) };
}

function toBulkEditOperation(value: unknown): BulkEditCatalogItemOperation {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const action = String(record.action ?? "");

  switch (action) {
    case "assignBlueprint":
      return {
        action,
        blueprintId: toOptionalString(record.blueprintId) ?? "",
      };
    case "assignCategory":
    case "removeCategory":
      return {
        action,
        categoryId: toOptionalString(record.categoryId) ?? "",
      };
    case "setTags":
    case "mergeTags":
      return {
        action,
        tags: toStringArray(record.tags),
      };
    case "clearTags":
      return { action };
    default:
      throw new CatalogDomainError("Unknown Catalog Item bulk edit action.");
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toLocalizedTextMap(value: unknown): LocalizedTextMap {
  if (value && typeof value === "object" && "defaultLocale" in value && "values" in value) {
    return value as LocalizedTextMap;
  }

  return {
    defaultLocale: "en",
    values: {
      en: String(value ?? ""),
    },
  };
}

function toImageFallback(value: unknown): CatalogItemImageFallback {
  const fallback = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    url: String(fallback.url ?? ""),
    alt: String(fallback.alt ?? ""),
    usage: fallback.usage === "loading-only" ? "loading-only" : "permanent",
    variants: toImageFallbackVariants(fallback.variants),
  };
}

function toImageFallbackVariants(value: unknown): CatalogItemImageFallback["variants"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([size, density]) => {
      const entry =
        density && typeof density === "object" && !Array.isArray(density) ? (density as Record<string, unknown>) : {};

      return [
        size,
        {
          oneX: typeof entry.oneX === "string" ? entry.oneX : undefined,
          twoX: typeof entry.twoX === "string" ? entry.twoX : undefined,
        },
      ];
    }),
  );
}
