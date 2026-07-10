import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import {
  parseOptionalTypedIdBoundary,
  parseTypedIdArrayBoundary,
  parseTypedIdBoundary,
} from "@chase-sets/http/typed-id";
import type { ComponentServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

export function componentRoutes(services: ComponentServices, authoringBulkJobs: CatalogAuthoringBulkJobServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const componentId = parseTypedIdBoundary(body.componentId, "cmp", "componentId");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "CreateComponent",
        componentId,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
      },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result), 201);
  });

  app.post("/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.bulkLifecycle.preview(
      normalizeBulkSelection(body.selection, componentListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.components.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, componentListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.post("/:id/field-rules", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "AddFieldRuleToComponent",
        fieldId: parseTypedIdBoundary(body.fieldId, "fld", "fieldId"),
        required: body.required,
      },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result), 201);
  });

  app.delete("/:id/field-rules/:fieldId", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "RemoveFieldRuleFromComponent",
        fieldId: parseTypedIdBoundary(c.req.param("fieldId"), "fld", "fieldId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result));
  });

  app.post("/:id/dimension-rules", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "AddDimensionRuleToComponent",
        dimensionId: parseTypedIdBoundary(body.dimensionId, "dim", "dimensionId"),
        required: body.required,
        allowedOptionIds:
          body.allowedOptionIds === undefined
            ? undefined
            : parseTypedIdArrayBoundary(body.allowedOptionIds, "chc", "allowedOptionIds"),
        appliesWhen: body.appliesWhen,
      },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result), 201);
  });

  app.delete("/:id/dimension-rules/:dimensionId", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "RemoveDimensionRuleFromComponent",
        dimensionId: parseTypedIdBoundary(c.req.param("dimensionId"), "dim", "dimensionId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result));
  });

  app.put("/:id", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "ConfigureComponentRules",
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        fieldRules: body.fieldRules,
        dimensionRules: body.dimensionRules,
      },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result));
  });

  app.post("/:id/activate", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "ActivateComponent" },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result));
  });

  app.post("/:id/deprecate", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "DeprecateComponent" },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result));
  });

  app.post("/:id/archive", async (c) => {
    const componentId = parseTypedIdBoundary(c.req.param("id"), "cmp", "componentId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "ArchiveComponent" },
      context,
    });

    return c.json(commandSnapshotResponse(componentId, result));
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, hasFieldRules, hasDimensionRules } = c.req.query();
    const result = await services.listComponents({
      search,
      status,
      hasFieldRules,
      hasDimensionRules,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const component = await services.getComponentDetail(c.req.param("id"));

    if (!component) {
      return c.json(
        { error: { code: "not_found", message: t("catalog.features.components.api.route.component.not.found") } },
        404,
      );
    }

    return c.json(component);
  });

  return app;
}

function componentListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    hasFieldRules: toOptionalString(record.hasFieldRules),
    hasDimensionRules: toOptionalString(record.hasDimensionRules),
  };
}
