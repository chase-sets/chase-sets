import { Hono } from "hono";
import type { MarketplaceServices } from "../infrastructure/wiring";
import { listMarketplaceCategories } from "../projections/queries";

export function marketplaceCategoryRoutes(services: MarketplaceServices): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const parentCategoryId = c.req.query("parentCategoryId");
    const status = c.req.query("status");

    const categories = await listMarketplaceCategories(services.db, {
      parentCategoryId: parentCategoryId || undefined,
      status: status || undefined,
    });

    return c.json({ items: categories });
  });

  return app;
}
