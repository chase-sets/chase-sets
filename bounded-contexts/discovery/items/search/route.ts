import { Hono } from "hono";
import type { DiscoveryItemSearchServices } from "./runtime";

export function discoveryItemSearchRoutes(services: DiscoveryItemSearchServices) {
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

    const result = await services.searchItems({
      search: search || undefined,
      category: category || undefined,
      tag: tag || undefined,
      blueprintId: blueprintId || undefined,
      sort: sort || undefined,
      status: status || undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  return app;
}
