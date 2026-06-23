import { Hono } from "hono";
import type { InventoryCatalogItemServices } from "../../features/inventory-items/integrations/catalog/runtime";

export function inventoryCatalogItemRoutes(services: InventoryCatalogItemServices) {
  const app = new Hono();

  app.get("/", async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const result = await services.searchCatalogItems({
      search: c.req.query("search"),
      status: c.req.query("status"),
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/:id", async (c) => {
    const item = await services.getCatalogItem(c.req.param("id"));

    if (!item) {
      return c.json({ error: { code: "not_found", message: "Catalog item not found." } }, 404);
    }

    return c.json(item);
  });

  return app;
}
