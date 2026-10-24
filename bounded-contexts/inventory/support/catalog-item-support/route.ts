import { Hono } from "hono";
import type { InventoryCatalogItemServices } from "../../features/inventory-items/integrations/catalog/runtime";

export function inventoryCatalogItemRoutes(services: InventoryCatalogItemServices) {
  const app = new Hono();

  app.get("/:id", async (c) => {
    const item = await services.getCatalogItem(c.req.param("id"));

    if (!item) {
      return c.json({ error: { code: "not_found", message: "Catalog item not found." } }, 404);
    }

    return c.json(item);
  });

  return app;
}
