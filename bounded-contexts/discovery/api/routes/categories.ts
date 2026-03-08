import { Hono } from "hono";
import type { DiscoveryServices } from "../services";
import { listDiscoveryCategories } from "../projections/queries";

export function discoveryCategoryRoutes(services: DiscoveryServices): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const parentCategoryId = c.req.query("parentCategoryId");
    const status = c.req.query("status");

    const categories = await listDiscoveryCategories(services.db, {
      parentCategoryId: parentCategoryId || undefined,
      status: status || undefined,
    });

    return c.json({ items: categories });
  });

  return app;
}
