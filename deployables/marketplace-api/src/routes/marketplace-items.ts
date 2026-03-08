import { Hono } from "hono";
import type { MarketplaceServices } from "../infrastructure/wiring";
import { searchMarketplaceItems, getMarketplaceItemDetail } from "../projections/queries";

export function marketplaceItemRoutes(services: MarketplaceServices): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const search = c.req.query("search");
    const category = c.req.query("category");
    const tag = c.req.query("tag");
    const blueprintId = c.req.query("blueprintId");
    const sort = c.req.query("sort");
    const status = c.req.query("status");
    const limit = c.req.query("limit");
    const offset = c.req.query("offset");

    const result = await searchMarketplaceItems(services.db, {
      search: search || undefined,
      category: category || undefined,
      tag: tag || undefined,
      blueprintId: blueprintId || undefined,
      sort: sort || undefined,
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    return c.json(result);
  });

  app.get("/:id", async (c) => {
    const itemId = c.req.param("id");
    const item = await getMarketplaceItemDetail(services.db, itemId);

    if (!item) {
      return c.json({ error: "Item not found." }, 404);
    }

    return c.json(item);
  });

  return app;
}
