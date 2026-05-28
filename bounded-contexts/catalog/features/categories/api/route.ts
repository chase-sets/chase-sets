import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CategoryServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import type { CategoryId } from "../../../ids";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

export function categoryRoutes(services: CategoryServices, authoringBulkJobs: CatalogAuthoringBulkJobServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const categoryId = body.categoryId as CategoryId;

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: {
        type: "CreateCategory",
        categoryId,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        parentCategoryId: body.parentCategoryId as CategoryId | undefined,
        displayOrder: body.displayOrder,
      },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status }, 201);
  });

  app.post("/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.bulkLifecycle.preview(
      normalizeBulkSelection(body.selection, categoryListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.categories.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, categoryListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.put("/:id", async (c) => {
    const categoryId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: {
        type: "ReviseCategory",
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        parentCategoryId: body.parentCategoryId as CategoryId | undefined,
        displayOrder: body.displayOrder,
      },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/publish", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "PublishCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "DeprecateCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "ArchiveCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, parentCategoryId, hierarchy } = c.req.query();
    const result = await services.listCategories({
      search,
      status,
      hierarchy,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
      parentCategoryId,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const category = await services.getCategoryDetail(c.req.param("id"));

    if (!category) {
      return c.json(
        { error: { code: "not_found", message: t("catalog.features.categories.api.route.category.not.found") } },
        404,
      );
    }

    return c.json(category);
  });

  return app;
}

function categoryListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    parentCategoryId: toOptionalString(record.parentCategoryId),
    hierarchy: toOptionalString(record.hierarchy),
  };
}
