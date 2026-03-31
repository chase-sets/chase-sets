import { Hono } from "hono";
import type { ComponentServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../api";
import type { ComponentId, FieldId, DimensionId, ChoiceId } from "../../ids";


export function componentRoutes(services: ComponentServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const componentId = body.componentId as ComponentId;

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "CreateComponent",
        componentId,
        key: body.key,
        name: body.name,
        description: body.description,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status }, 201);
  });

  app.post("/:id/field-rules", async (c) => {
    const componentId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
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

    const result = await services.commandHandler({
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

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "AddDimensionRuleToComponent",
        dimensionId: body.dimensionId as DimensionId,
        required: body.required,
        allowedChoiceIds: body.allowedChoiceIds as ChoiceId[] | undefined,
        appliesWhen: body.appliesWhen,
      },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status }, 201);
  });

  app.delete("/:id/dimension-rules/:dimensionId", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
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

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: {
        type: "ConfigureComponentRules",
        key: body.key,
        name: body.name,
        description: body.description,
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

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "ActivateComponent" },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "DeprecateComponent" },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const componentId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.component-${componentId}`,
      command: { type: "ArchiveComponent" },
      context,
    });

    return c.json({ id: componentId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listComponents({ search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const component = await services.getComponentDetail(c.req.param("id"));

    if (!component) {
      return c.json({ error: "Component not found." }, 404);
    }

    return c.json(component);
  });

  return app;
}







