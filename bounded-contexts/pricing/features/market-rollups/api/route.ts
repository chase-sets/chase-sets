import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { RollupGranularity } from "../read-model/queries";
import type { MarketRollupsServices } from "./runtime";

/**
 * The market-rollups HTTP surface: buyer-facing GET reads over the Daily
 * Product Rollup / Market-State Snapshot / Product Market Aggregate query
 * API (../read-model/queries.ts). No write endpoints -- these three tables
 * are maintained exclusively by the scheduled closer job
 * (../read-model/rollup-maintenance.ts). Public reads (no `actor` gate):
 * the item-detail market panel is the first consumer and renders for
 * anonymous buyers, matching the existing discoveryItemDetailRoutes GET
 * /:id posture.
 */

const ROLLUP_GRANULARITIES: readonly RollupGranularity[] = ["daily", "weekly", "monthly"];

function isRollupGranularity(value: string | undefined): value is RollupGranularity {
  return ROLLUP_GRANULARITIES.includes(value as RollupGranularity);
}

function isIsoCalendarDate(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function createMarketRollupsRoutes(services: MarketRollupsServices) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.get("/:catalogItemId/:productId/series", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const granularity = c.req.query("granularity");

    if (!isIsoCalendarDate(from) || !isIsoCalendarDate(to)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: t("pricing.features.marketRollups.api.route.from.and.to.must.be.iso.calendar"),
          },
        },
        400,
      );
    }

    if (granularity !== undefined && !isRollupGranularity(granularity)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: t("pricing.features.marketRollups.api.route.invalid.granularity"),
          },
        },
        400,
      );
    }

    const series = await services.getProductRollupSeries({
      catalogItemId: c.req.param("catalogItemId"),
      productId: c.req.param("productId"),
      from,
      to,
      granularity,
    });

    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ items: series });
  });

  app.get("/:catalogItemId/:productId/stats", async (c) => {
    const stats = await services.getProductMarketStatsSnapshot({
      catalogItemId: c.req.param("catalogItemId"),
      productId: c.req.param("productId"),
    });

    c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    return c.json(stats);
  });

  return app;
}
