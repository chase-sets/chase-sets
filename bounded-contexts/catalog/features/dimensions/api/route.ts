import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdArrayBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { DimensionServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

export function dimensionRoutes(services: DimensionServices, authoringBulkJobs: CatalogAuthoringBulkJobServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const dimensionId = parseTypedIdBoundary(body.dimensionId, "dim", "dimensionId");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "CreateDimension",
        dimensionId,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        valueKind: body.valueKind,
      },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result), 201);
  });

  app.post("/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.bulkLifecycle.preview(
      normalizeBulkSelection(body.selection, dimensionListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.dimensions.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, dimensionListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.put("/:id", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReviseDimension",
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        valueKind: body.valueKind,
      },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.post("/:id/options", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "AddOption",
        optionId: parseTypedIdBoundary(body.optionId, "chc", "optionId"),
        code: body.code,
        label: coerceOptionLabel(body.label),
        numericValue: body.numericValue,
      },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result), 201);
  });

  app.put("/:id/options/:optionId", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReviseOption",
        optionId: parseTypedIdBoundary(c.req.param("optionId"), "chc", "optionId"),
        code: body.code,
        label: coerceOptionLabel(body.label),
        numericValue: body.numericValue,
      },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.put("/:id/options/order", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReorderOptions",
        optionIds: parseTypedIdArrayBoundary(body.optionIds, "chc", "optionIds"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.post("/:id/options/:optionId/deprecate", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "DeprecateOption",
        optionId: parseTypedIdBoundary(c.req.param("optionId"), "chc", "optionId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.post("/:id/options/:optionId/reactivate", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReactivateOption",
        optionId: parseTypedIdBoundary(c.req.param("optionId"), "chc", "optionId"),
      },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.post("/:id/activate", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "ActivateDimension" },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.post("/:id/deprecate", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "DeprecateDimension" },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.post("/:id/archive", async (c) => {
    const dimensionId = parseTypedIdBoundary(c.req.param("id"), "dim", "dimensionId");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "ArchiveDimension" },
      context,
    });

    return c.json(commandSnapshotResponse(dimensionId, result));
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, valueKind } = c.req.query();
    const result = await services.listDimensions({
      search,
      status,
      valueKind,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const dimension = await services.getDimension(c.req.param("id"));

    if (!dimension) {
      return c.json(
        { error: { code: "not_found", message: t("catalog.features.dimensions.api.route.dimension.not.found") } },
        404,
      );
    }

    return c.json(dimension);
  });

  return app;
}

function dimensionListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    valueKind: toOptionalString(record.valueKind),
  };
}

function coerceOptionLabel(value: unknown) {
  if (Array.isArray(value)) {
    return coerceLocalizedTextMap({
      defaultLocale: "en",
      values: Object.fromEntries(
        value
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) {
              return null;
            }

            const candidate = entry as { locale?: unknown; value?: unknown };
            return typeof candidate.locale === "string" && typeof candidate.value === "string"
              ? [candidate.locale, candidate.value]
              : null;
          })
          .filter((entry): entry is [string, string] => entry !== null),
      ),
    });
  }

  return coerceLocalizedTextMap(value);
}
