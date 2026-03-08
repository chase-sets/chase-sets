import { Hono } from "hono";
import type { CatalogServices } from "../infrastructure/wiring";
import type { TenantContextEnv } from "../middleware/tenant-context";
import type { CategoryId } from "../../../../bounded-contexts/catalog/ids";
import { listCategories, getCategory, resolveCategoryNames } from "../projections/queries";

export function categoryRoutes(services: CatalogServices): Hono<TenantContextEnv> {
  const app = new Hono<TenantContextEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const categoryId = body.categoryId as CategoryId;

    const result = await services.categoryHandler({
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

    const result = await services.categoryHandler({
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

    const result = await services.categoryHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "PublishCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.categoryHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "DeprecateCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const categoryId = c.req.param("id");
    const context = c.get("context");

    const result = await services.categoryHandler({
      streamId: `catalog.category-${categoryId}`,
      command: { type: "ArchiveCategory" },
      context,
    });

    return c.json({ id: categoryId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, limit, offset, parentCategoryId } = c.req.query();
    const result = await listCategories(services.db, { search, status, limit: Number(limit) || undefined, offset: Number(offset) || undefined, parentCategoryId });

    const parentIds = [...new Set(result.items.map((i) => i.parent_category_id).filter((id): id is string => id !== null))];
    const parents = await resolveCategoryNames(services.db, parentIds);
    const parentNameMap = Object.fromEntries(parents.map((p) => [p.id, p.name]));

    return c.json({ items: result.items, total: result.total, count: result.items.length, _resolvedNames: parentNameMap });
  });

  app.get("/:id", async (c) => {
    const category = await getCategory(services.db, c.req.param("id"));

    if (!category) {
      return c.json({ error: "Category not found." }, 404);
    }

    const categories = category.parent_category_id
      ? await resolveCategoryNames(services.db, [category.parent_category_id])
      : [];

    return c.json({ ...category, _resolved: { categories } });
  });

  return app;
}
