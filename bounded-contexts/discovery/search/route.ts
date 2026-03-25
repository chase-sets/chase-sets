import { Hono } from "hono";
import type { DiscoveryServices } from "../services";
import { searchDiscoveryItems } from "./queries";

export function discoverySearchRoutes(services: DiscoveryServices): Hono {
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

    const result = await searchDiscoveryItems(services.db, {
      search: search || undefined,
      category: category || undefined,
      tag: tag || undefined,
      blueprintId: blueprintId || undefined,
      sort: sort || undefined,
      status: status || undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });

    return c.json(result);
  });

  return app;
}

