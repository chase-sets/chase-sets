import { Hono } from "hono";
import type { CatalogServices } from "../infrastructure/wiring";
import type { TenantContextEnv } from "../middleware/tenant-context";
import type { BlueprintId, ComponentId } from "../../../../bounded-contexts/catalog/ids";
import { listBlueprints, getBlueprint, resolveComponentNames, resolveFieldNames, resolveDimensionNames, resolveChoiceCodes } from "../projections/queries";

export function blueprintRoutes(services: CatalogServices): Hono<TenantContextEnv> {
  const app = new Hono<TenantContextEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const blueprintId = body.blueprintId as BlueprintId;

    const result = await services.blueprintHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "CreateBlueprint",
        blueprintId,
        key: body.key,
        name: body.name,
        description: body.description,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const blueprintId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.blueprintHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "ReviseBlueprint",
        key: body.key,
        name: body.name,
        description: body.description,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/components/:componentId", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.blueprintHandler({
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

    const result = await services.blueprintHandler({
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

    const result = await services.blueprintHandler({
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

    const result = await services.blueprintHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "SetBlueprintDimensions",
        dimensionRules: body.dimensionRules,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.put("/:id/version-rules", async (c) => {
    const blueprintId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.blueprintHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: {
        type: "SetBlueprintVersionRules",
        canonicalDimensionOrder: body.canonicalDimensionOrder,
      },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/publish", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.blueprintHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "PublishBlueprint" },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.blueprintHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "DeprecateBlueprint" },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const blueprintId = c.req.param("id");
    const context = c.get("context");

    const result = await services.blueprintHandler({
      streamId: `catalog.blueprint-${blueprintId}`,
      command: { type: "ArchiveBlueprint" },
      context,
    });

    return c.json({ id: blueprintId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await listBlueprints(services.db, { search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const blueprint = await getBlueprint(services.db, c.req.param("id"));

    if (!blueprint) {
      return c.json({ error: "Blueprint not found." }, 404);
    }

    const componentIds = (blueprint.component_ids ?? []) as string[];
    const fieldIds = ((blueprint.field_rules ?? []) as { fieldId: string }[]).map((r) => r.fieldId);
    const dimRules = (blueprint.dimension_rules ?? []) as { dimensionId: string; allowedChoiceIds: string[] }[];
    const dimensionIds = [
      ...dimRules.map((r) => r.dimensionId),
      ...((blueprint.canonical_dimension_order ?? []) as string[]),
    ].filter((id, i, arr) => arr.indexOf(id) === i);
    const choiceIds = dimRules.flatMap((r) => r.allowedChoiceIds ?? []);

    const [components, fields, dimensions, choices] = await Promise.all([
      resolveComponentNames(services.db, componentIds),
      resolveFieldNames(services.db, fieldIds),
      resolveDimensionNames(services.db, dimensionIds),
      resolveChoiceCodes(services.db, choiceIds),
    ]);

    return c.json({ ...blueprint, _resolved: { components, fields, dimensions, choices } });
  });

  app.get("/:id/resolve-names", async (c) => {
    const blueprint = await getBlueprint(services.db, c.req.param("id"));

    if (!blueprint) {
      return c.json({ error: "Blueprint not found." }, 404);
    }

    const componentIds = (blueprint.component_ids ?? []) as string[];
    const fieldIds = ((blueprint.field_rules ?? []) as { fieldId: string }[]).map((r) => r.fieldId);
    const dimensionIds = ((blueprint.dimension_rules ?? []) as { dimensionId: string }[]).map((r) => r.dimensionId);

    const [components, fields, dimensions] = await Promise.all([
      resolveComponentNames(services.db, componentIds),
      resolveFieldNames(services.db, fieldIds),
      resolveDimensionNames(services.db, dimensionIds),
    ]);

    return c.json({ components, fields, dimensions });
  });

  return app;
}
