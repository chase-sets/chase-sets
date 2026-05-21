import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { DimensionServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { DimensionId, OptionId } from "../../../ids";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

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
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        valueKind: body.valueKind,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status }, 201);
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
    const result = await services.bulkLifecycle.execute(
      normalizeBulkSelection(body.selection, dimensionListQueryFromRecord),
      String(body.action ?? ""),
      c.get("context"),
    );

    return c.json(result);
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
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
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
        label: coerceOptionLabel(body.label),
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
        label: coerceOptionLabel(body.label),
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
