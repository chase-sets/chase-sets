import { Hono } from "hono";
import type { CatalogServices } from "../infrastructure/wiring";
import type { TenantContextEnv } from "../middleware/tenant-context";
import type { DimensionId, ChoiceId } from "../../../../bounded-contexts/catalog/ids";
import { listDimensions, getDimension } from "../projections/queries";

export function dimensionRoutes(services: CatalogServices): Hono<TenantContextEnv> {
  const app = new Hono<TenantContextEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const dimensionId = body.dimensionId as DimensionId;

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "CreateDimension",
        dimensionId,
        key: body.key,
        name: body.name,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReviseDimension",
        key: body.key,
        name: body.name,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/choices", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "AddChoice",
        choiceId: body.choiceId as ChoiceId,
        code: body.code,
        labels: body.labels ?? [],
        numericValue: body.numericValue,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id/choices/:choiceId", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReviseChoice",
        choiceId: c.req.param("choiceId") as ChoiceId,
        code: body.code,
        labels: body.labels ?? [],
        numericValue: body.numericValue,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.put("/:id/choices/order", async (c) => {
    const dimensionId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReorderChoices",
        choiceIds: body.choiceIds as ChoiceId[],
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/choices/:choiceId/deprecate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "DeprecateChoice",
        choiceId: c.req.param("choiceId") as ChoiceId,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/choices/:choiceId/reactivate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: {
        type: "ReactivateChoice",
        choiceId: c.req.param("choiceId") as ChoiceId,
      },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/activate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "ActivateDimension" },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "DeprecateDimension" },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const dimensionId = c.req.param("id");
    const context = c.get("context");

    const result = await services.dimensionHandler({
      streamId: `catalog.dimension-${dimensionId}`,
      command: { type: "ArchiveDimension" },
      context,
    });

    return c.json({ id: dimensionId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const items = await listDimensions(services.db);

    return c.json({ items, count: items.length });
  });

  app.get("/:id", async (c) => {
    const dimension = await getDimension(services.db, c.req.param("id"));

    if (!dimension) {
      return c.json({ error: "Dimension not found." }, 404);
    }

    return c.json(dimension);
  });

  return app;
}
