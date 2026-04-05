import { Hono } from "hono";
import type { CategoryServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../api";
import type { CategoryId } from "../ids";


export function categoryRoutes(services: CategoryServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const categoryId = body.categoryId as CategoryId;

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: {
        type: "CreateCategory",
        categoryId,
        key: body.key,
        name: body.name,
        description: body.description,
        parentCategoryId: body.parentCategoryId as CategoryId | undefined,
        displayOrder: body.displayOrder,
      },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const categoryId = c.req.param("id");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: {
        type: "ReviseCategory",
        key: body.key,
        name: body.name,
        description: body.description,
        parentCategoryId: body.parentCategoryId as CategoryId | undefined,
        displayOrder: body.displayOrder,
      },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/publish", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "PublishCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "DeprecateCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.commandHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "ArchiveCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, parentCategoryId } = c.req.query();
    const result = await services.listCategories({ search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined, parentCategoryId });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const category = await services.getCategoryDetail(c.req.param("id"));

    if (!category) {
      return c.json({ error: "Category not found." }, 404);
    }

    return c.json(category);
  });

  return app;
}





