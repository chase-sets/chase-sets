import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { BlueprintServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

export function blueprintRoutes(services: BlueprintServices, authoringBulkJobs: CatalogAuthoringBulkJobServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const blueprintId = parseTypedIdBoundary(body.blueprintId, "bpr", "blueprintId");

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

    return c.json(commandSnapshotResponse(blueprintId, result), 201);
  });

  app.post("/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.bulkLifecycle.preview(
      normalizeBulkSelection(body.selection, blueprintListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.blueprints.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, blueprintListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.put("/:id", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
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

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.post("/:id/components/:componentId", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "AttachComponentToBlueprint",
        componentId: parseTypedIdBoundary(c.req.param("componentId"), "cmp", "componentId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(blueprintId, result), 201);
  });

  app.delete("/:id/components/:componentId", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "DetachComponentFromBlueprint",
        componentId: parseTypedIdBoundary(c.req.param("componentId"), "cmp", "componentId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.put("/:id/fields", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
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

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.put("/:id/dimensions", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
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

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.put("/:id/product-resolution-rules", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
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

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.post("/:id/publish", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "PublishBlueprint" },
      context,
    });

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.post("/:id/deprecate", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "DeprecateBlueprint" },
      context,
    });

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.post("/:id/archive", async (c) => {
    const blueprintId = parseTypedIdBoundary(c.req.param("id"), "bpr", "blueprintId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "ArchiveBlueprint" },
      context,
    });

    return c.json(commandSnapshotResponse(blueprintId, result));
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, hasComponents, hasFieldRules, hasDimensionRules } = c.req.query();
    const result = await services.listBlueprints({
      search,
      status,
      hasComponents,
      hasFieldRules,
      hasDimensionRules,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const blueprint = await services.getBlueprintDetail(c.req.param("id"));

    if (!blueprint) {
      return c.json(
        { error: { code: "not_found", message: t("catalog.features.blueprints.api.route.blueprint.not.found") } },
        404,
      );
    }

    return c.json(blueprint);
  });

  return app;
}

function blueprintListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    hasComponents: toOptionalString(record.hasComponents),
    hasFieldRules: toOptionalString(record.hasFieldRules),
    hasDimensionRules: toOptionalString(record.hasDimensionRules),
  };
}
