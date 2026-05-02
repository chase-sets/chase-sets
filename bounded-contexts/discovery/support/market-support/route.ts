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

  app.get("/sellers/:slug", async (c) => {
    const seller = await services.getPublicSellerBySlug(c.req.param("slug"));

    if (!seller) {
      return c.json({ error: { code: "not_found", message: "Seller not found." } }, 404);
    }

    return c.json(seller);
  });

  app.get("/sitemap-urls", async (c) => {
    const items = await services.listPublicSitemapUrls();

    return c.json({ items, total: items.length, count: items.length });
  });

  return app;
}
