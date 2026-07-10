import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { FieldServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

export function fieldRoutes(services: FieldServices, authoringBulkJobs: CatalogAuthoringBulkJobServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const fieldId = parseTypedIdBoundary(body.fieldId, "fld", "fieldId");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: {
        type: "CreateField",
        fieldId,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        valueType: body.valueType,
        behavior: body.behavior,
      },
      context,
    });

    return c.json(commandSnapshotResponse(fieldId, result), 201);
  });

  app.post("/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.bulkLifecycle.preview(
      normalizeBulkSelection(body.selection, fieldListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.fields.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, fieldListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.put("/:id", async (c) => {
    const fieldId = parseTypedIdBoundary(c.req.param("id"), "fld", "fieldId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: {
        type: "ConfigureField",
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        valueType: body.valueType,
        behavior: body.behavior,
      },
      context,
    });

    return c.json(commandSnapshotResponse(fieldId, result));
  });

  app.post("/:id/activate", async (c) => {
    const fieldId = parseTypedIdBoundary(c.req.param("id"), "fld", "fieldId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: { type: "ActivateField" },
      context,
    });

    return c.json(commandSnapshotResponse(fieldId, result));
  });

  app.post("/:id/deprecate", async (c) => {
    const fieldId = parseTypedIdBoundary(c.req.param("id"), "fld", "fieldId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: { type: "DeprecateField" },
      context,
    });

    return c.json(commandSnapshotResponse(fieldId, result));
  });

  app.post("/:id/archive", async (c) => {
    const fieldId = parseTypedIdBoundary(c.req.param("id"), "fld", "fieldId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.field-${fieldId}`,
      command: { type: "ArchiveField" },
      context,
    });

    return c.json(commandSnapshotResponse(fieldId, result));
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, valueType, filterable, searchable, sortable } = c.req.query();
    const result = await services.listFields({
      search,
      status,
      valueType,
      filterable,
      searchable,
      sortable,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const field = await services.getField(c.req.param("id"));

    if (!field) {
      return c.json(
        { error: { code: "not_found", message: t("catalog.features.fields.api.route.field.not.found") } },
        404,
      );
    }

    return c.json(field);
  });

  return app;
}

function fieldListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    valueType: toOptionalString(record.valueType),
    filterable: toOptionalString(record.filterable),
    searchable: toOptionalString(record.searchable),
    sortable: toOptionalString(record.sortable),
  };
}
