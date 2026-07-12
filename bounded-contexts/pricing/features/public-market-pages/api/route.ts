import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import type { PublicMarketPagesServices } from "./runtime";

/**
 * Public, unauthenticated read routes for the SEO market pages.
 * Mounted under Pricing's existing `/api/marketplace` mount alongside the
 * account-scoped recommendation routes: that mount's `requiresAuth: true`
 * only attaches `platformActorMiddleware`, which resolves actor-or-null
 * without rejecting the request (see deployables/platform-api/src/app.ts) --
 * the hard authentication gate applies only to the auth/identity mounts.
 * These handlers never read `c.get("actor")`, matching discovery's public
 * search route (bounded-contexts/discovery/features/search/api/route.ts).
 */
export function createPublicMarketPageRoutes(services: PublicMarketPagesServices) {
  const app = new Hono<PricingApiEnv>();

  app.get("/:slug", async (c) => {
    const [page, display] = await Promise.all([
      services.getPublicMarketPage(c.req.param("slug")),
      services.resolveDisplayPolicy(),
    ]);
    if (!page) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("pricing.features.publicMarketPages.api.route.market.page.not.found"),
          },
        },
        404,
      );
    }

    // The resolved display policy's publicPageCacheTtlSeconds -- a revision
    // changes this response's shared-cache lifetime without a deploy. The
    // outer SSR route (routes/marketplace/market-price-history.tsx)
    // still sets its own static Cache-Control: React Router's `headers()`
    // export is synchronous and has no request-scoped async policy
    // resolution today, so that document-level header stays a compiled-
    // default literal pending a broader loader-header-forwarding convention.
    c.header(
      "Cache-Control",
      `public, max-age=60, s-maxage=${display.publicPageCacheTtlSeconds}, stale-while-revalidate=3600`,
    );
    return c.json(page);
  });

  app.get("/", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const entries = await services.listPublicMarketPageSlugs(
      Number.isFinite(limit) && limit! > 0 ? { limit } : undefined,
    );

    return c.json({ items: entries, count: entries.length });
  });

  return app;
}
