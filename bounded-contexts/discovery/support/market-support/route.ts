import { Hono } from "hono";
import type { DiscoveryMarketServices } from "./runtime";

export function discoveryMarketRoutes(services: DiscoveryMarketServices) {
  const app = new Hono();

  app.get("/listings/:slug", async (c) => {
    const listing = await services.getPublicListingBySlug(c.req.param("slug"));

    if (!listing) {
      return c.json({ error: { code: "not_found", message: "Listing not found." } }, 404);
    }

    return c.json(listing);
  });

  app.get("/accounts/:slug", async (c) => {
    const account = await services.getPublicAccountBySlug(c.req.param("slug"));

    if (!account) {
      return c.json({ error: { code: "not_found", message: "Account not found." } }, 404);
    }

    return c.json(account);
  });

  app.get("/sitemap-urls", async (c) => {
    const items = await services.listPublicSitemapUrls();

    return c.json({ items, total: items.length, count: items.length });
  });

  return app;
}
