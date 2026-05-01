import { Hono } from "hono";
import type { DimensionServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { DimensionId, OptionId } from "../../../ids";


export function dimensionRoutes(services: DimensionServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const dimensionId = body.dimensionId as DimensionId;

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "CreateDimension",
        dimensionId,
        key: body.key,
        name: body.name,
        description: body.description,
        valueKind: body.valueKind,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReviseDimension",
        key: body.key,
        name: body.name,
        description: body.description,
        valueKind: body.valueKind,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/options", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "AddOption",
        optionId: body.optionId as OptionId,
        code: body.code,
        labels: body.labels ?? [],
        numericValue: body.numericValue,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id/options/:optionId", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReviseOption",
        optionId: c.req.param("optionId") as OptionId,
        code: body.code,
        labels: body.labels ?? [],
        numericValue: body.numericValue,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.put("/:id/options/order", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReorderOptions",
        optionIds: body.optionIds as OptionId[],
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/options/:optionId/deprecate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "DeprecateOption",
        optionId: c.req.param("optionId") as OptionId,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/options/:optionId/reactivate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReactivateOption",
        optionId: c.req.param("optionId") as OptionId,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/activate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "ActivateDimension" },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "DeprecateDimension" },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "ArchiveDimension" },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listDimensions({ search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const dimension = await services.getDimension(c.req.param("id"));

    if (!dimension) {
      return c.json({ error: { code: "not_found", message: "Dimension not found." } }, 404);
    }

    return c.json(dimension);
  });

  return app;
}


