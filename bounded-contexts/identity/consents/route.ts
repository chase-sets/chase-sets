import { Hono } from "hono";
import type { IdentityApiEnv } from "../api";
import type { ConsentServices } from "./runtime";

export function consentRoutes(services: ConsentServices) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const { search, status, limit, offset } = c.req.query();
    const result = await services.listConsents({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  return app;
}
