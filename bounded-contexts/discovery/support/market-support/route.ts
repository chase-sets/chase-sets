import { Hono } from "hono";
import type { DiscoverySitemapEntityKind } from "../client-support/contracts";
import { DISCOVERY_SITEMAP_ENTITY_KINDS } from "./queries";
import type { DiscoveryMarketServices } from "./runtime";

function isDiscoverySitemapEntityKind(value: string): value is DiscoverySitemapEntityKind {
  return (DISCOVERY_SITEMAP_ENTITY_KINDS as readonly string[]).includes(value);
}

function readAccountReviewRoleFilter(value: string | undefined): "seller" | "buyer" | undefined {
  return value === "seller" || value === "buyer" ? value : undefined;
}

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
    const account = await services.getPublicAccountBySlug(c.req.param("slug"), {
      reviewRole: readAccountReviewRoleFilter(c.req.query("role")),
      reviewLimit: Number(c.req.query("limit") ?? 10),
      reviewOffset: Number(c.req.query("offset") ?? 0),
    });

    if (!account) {
      return c.json({ error: { code: "not_found", message: "Account not found." } }, 404);
    }

    return c.json(account);
  });

  app.get("/sitemap-entity-counts", async (c) => {
    const counts = await services.countPublicSitemapEntities();

    return c.json(counts);
  });

  app.get("/sitemap-entities/:kind/:page", async (c) => {
    const kind = c.req.param("kind");
    const page = Number(c.req.param("page"));

    if (!isDiscoverySitemapEntityKind(kind) || !Number.isInteger(page) || page < 1) {
      return c.json({ error: { code: "invalid_request", message: "Invalid sitemap entity kind or page." } }, 400);
    }

    const items = await services.listPublicSitemapEntityPage(kind, page);

    return c.json({ items, count: items.length });
  });

  return app;
}
