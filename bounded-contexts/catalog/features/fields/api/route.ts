import { Hono } from "hono";
import type { FieldServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { FieldId } from "../../../ids";


export function fieldRoutes(services: FieldServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const fieldId = body.fieldId as FieldId;

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: {
        type: "CreateField",
        fieldId,
        key: body.key,
        name: body.name,
        description: body.description,
        valueType: body.valueType,
        behavior: body.behavior,
      },
      context,
    });

    return c.json({ id: fieldId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const fieldId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: {
        type: "ConfigureField",
        key: body.key,
        name: body.name,
        description: body.description,
        valueType: body.valueType,
        behavior: body.behavior,
      },
      context,
    });

    return c.json({ id: fieldId, version: result.version, status: result.state.status });
  });

  app.post("/:id/activate", async (c) => {
    const fieldId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: { type: "ActivateField" },
      context,
    });

    return c.json({ id: fieldId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const fieldId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: { type: "DeprecateField" },
      context,
    });

    return c.json({ id: fieldId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const fieldId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: { type: "ArchiveField" },
      context,
    });

    return c.json({ id: fieldId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listFields({ search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const field = await services.getField(c.req.param("id"));

    if (!field) {
      return c.json({ error: "Field not found." }, 404);
    }

    return c.json(field);
  });

  return app;
}





