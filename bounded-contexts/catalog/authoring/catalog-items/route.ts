import { Hono } from "hono";
import type { CatalogItemServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../api";
import type { CatalogItemId, BlueprintId, FieldId, CategoryId } from "../../ids";


export function catalogItemRoutes(services: CatalogItemServices): Hono<CatalogAuthoringEnv> {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const itemId = body.itemId as CatalogItemId;

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "CreateItem",
        itemId,
        title: body.title,
        subtitle: body.subtitle,
        description: body.description,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status }, 201);
  });

  app.post("/:id/blueprint", async (c) => {
    const itemId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "AssignBlueprintToItem",
        blueprintId: body.blueprintId as BlueprintId,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.put("/:id/fields/:fieldId", async (c) => {
    const itemId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "SetItemFieldValue",
        fieldId: c.req.param("fieldId") as FieldId,
        value: body.value,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.delete("/:id/fields/:fieldId", async (c) => {
    const itemId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "ClearItemFieldValue",
        fieldId: c.req.param("fieldId") as FieldId,
        requiredFieldIds: body.requiredFieldIds as FieldId[] | undefined,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.post("/:id/categories/:categoryId", async (c) => {
    const itemId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "AssignItemToCategory",
        categoryId: c.req.param("categoryId") as CategoryId,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status }, 201);
  });

  app.delete("/:id/categories/:categoryId", async (c) => {
    const itemId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "RemoveItemFromCategory",
        categoryId: c.req.param("categoryId") as CategoryId,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.post("/:id/publish", async (c) => {
    const itemId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "PublishItem",
        blueprintIsActive: body.blueprintIsActive,
        requiredFieldIds: body.requiredFieldIds as FieldId[],
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.put("/:id/metadata", async (c) => {
    const itemId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "ReviseItemMetadata",
        title: body.title,
        subtitle: body.subtitle,
        description: body.description,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.put("/:id/tags", async (c) => {
    const itemId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "SetItemTags",
        tags: body.tags,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.put("/:id/image-urls", async (c) => {
    const itemId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: {
        type: "SetItemImageUrls",
        imageUrls: body.imageUrls,
      },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.post("/:id/retire", async (c) => {
    const itemId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: { type: "RetireItem" },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const itemId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.item-${itemId}`,
      command: { type: "ArchiveItem" },
      context,
    });

    return c.json({ id: itemId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, blueprintId, tag } = c.req.query();
    const result = await services.listCatalogItems({ search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined, blueprintId, tag });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const item = await services.getCatalogItemDetail(c.req.param("id"));

    if (!item) {
      return c.json({ error: "Catalog item not found." }, 404);
    }

    return c.json(item);
  });

  return app;
}





