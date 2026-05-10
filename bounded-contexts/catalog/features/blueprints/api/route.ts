import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { BlueprintServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { BlueprintId, ComponentId } from "../../../ids";


export function blueprintRoutes(services: BlueprintServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const blueprintId = body.blueprintId as BlueprintId;

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "CreateBlueprint",
        blueprintId,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const blueprintId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "ReviseBlueprint",
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/components/:componentId", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "AttachComponentToBlueprint",
        componentId: c.req.param("componentId") as ComponentId,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status }, 201);
  });

  app.delete("/:id/components/:componentId", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "DetachComponentFromBlueprint",
        componentId: c.req.param("componentId") as ComponentId,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.put("/:id/fields", async (c) => {
    const blueprintId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "SetBlueprintFields",
        fieldRules: body.fieldRules,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.put("/:id/dimensions", async (c) => {
    const blueprintId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "SetBlueprintDimensions",
        dimensionRules: body.dimensionRules,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.put("/:id/product-resolution-rules", async (c) => {
    const blueprintId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "SetBlueprintProductResolutionRules",
        canonicalDimensionOrder: body.canonicalDimensionOrder,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/publish", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "PublishBlueprint" },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "DeprecateBlueprint" },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "ArchiveBlueprint" },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listBlueprints({ search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const blueprint = await services.getBlueprintDetail(c.req.param("id"));

    if (!blueprint) {
      return c.json({ error: { code: "not_found", message: t("catalog.features.blueprints.api.route.blueprint.not.found") } }, 404);
    }

    return c.json(blueprint);
  });

  return app;
}




