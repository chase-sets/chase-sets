import { Hono } from "hono";
import type { InventoryCatalogItemServices } from "../../features/inventory-items/integrations/catalog/runtime";
import type { InventoryCatalogItemSnapshot } from "../../features/inventory-items/integrations/catalog/queries";
import { inventoryGradedSelections } from "../../features/inventory-items/integrations/catalog/graded-selection";

export function inventoryCatalogItemRoutes(services: InventoryCatalogItemServices) {
  const app = new Hono();

  app.get("/:id", async (c) => {
    const item = await services.getCatalogItem(c.req.param("id"));

    if (!item) {
      return c.json({ error: { code: "not_found", message: "Catalog item not found." } }, 404);
    }

    const snapshot: InventoryCatalogItemSnapshot = {
      ...item,
      graded_selections: inventoryGradedSelections(item.product_schema),
    };
    return c.json(snapshot);
  });

  return app;
}
