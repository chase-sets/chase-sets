import { Hono } from "hono";
import type { CatalogServices } from "../infrastructure/wiring";
import type { TenantContextEnv } from "../middleware/tenant-context";
import type { ComponentId, FieldId, DimensionId, ChoiceId } from "../../../../bounded-contexts/catalog/ids";
import { listComponents, getComponent } from "../projections/queries";

export function componentRoutes(services: CatalogServices): Hono<TenantContextEnv> {
  const app = new Hono<TenantContextEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const componentId = body.componentId as ComponentId;

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "CreateComponent",
        componentId,
        key: body.key,
        name: body.name,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status }, 201);
  });

  app.post("/:id/field-rules", async (c) => {
    const componentId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "AddFieldRuleToComponent",
        fieldId: body.fieldId as FieldId,
        required: body.required,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status }, 201);
  });

  app.delete("/:id/field-rules/:fieldId", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "RemoveFieldRuleFromComponent",
        fieldId: c.req.param("fieldId") as FieldId,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.post("/:id/dimension-rules", async (c) => {
    const componentId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "AddDimensionRuleToComponent",
        dimensionId: body.dimensionId as DimensionId,
        required: body.required,
        allowedChoiceIds: body.allowedChoiceIds as ChoiceId[] | undefined,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status }, 201);
  });

  app.delete("/:id/dimension-rules/:dimensionId", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "RemoveDimensionRuleFromComponent",
        dimensionId: c.req.param("dimensionId") as DimensionId,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.put("/:id", async (c) => {
    const componentId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "ConfigureComponentRules",
        key: body.key,
        name: body.name,
        fieldRules: body.fieldRules,
        dimensionRules: body.dimensionRules,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.post("/:id/activate", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "ActivateComponent" },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "DeprecateComponent" },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.componentHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "ArchiveComponent" },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const items = await listComponents(services.db);

    return c.json({ items, count: items.length });
  });

  app.get("/:id", async (c) => {
    const component = await getComponent(services.db, c.req.param("id"));

    if (!component) {
      return c.json({ error: "Component not found." }, 404);
    }

    return c.json(component);
  });

  return app;
}
