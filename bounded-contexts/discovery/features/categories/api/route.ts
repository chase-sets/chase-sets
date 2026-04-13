import { Hono } from "hono";
import type { DiscoveryCategoryServices } from "./runtime";

export function discoveryCategoryRoutes(services: DiscoveryCategoryServices) {
  const app = new Hono();

  app.get("/", async (c) => {
    const parentCategoryId = c.req.query("parentCategoryId");
    const status = c.req.query("status");

    const categories = (await services.listCategories({
      parentCategoryId: parentCategoryId || undefined,
      status: status || undefined,
    })).filter((category) => category.item_count > 0);

    return c.json({ items: categories, total: categories.length, count: categories.length });
  });

  return app;
}
