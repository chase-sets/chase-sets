import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { SellerMetricsServices } from "./runtime";

export type SellerMetricsApiEnv = AuthenticatedApiEnv;

export function createPublicSellerMetricsRoutes(services: SellerMetricsServices) {
  const app = new Hono<SellerMetricsApiEnv>();

  // Buyer-facing chips (AC: flag-gated, threshold-gated, "chips not raw
  // percentages"). Returns all-null chips -- the same shape as an
  // under-threshold seller -- when the rollout gate is off, so callers
  // never need to branch on gate state separately from sample-size state.
  app.get("/:accountId/behavioral-metrics-chips", async (c) => {
    const enabled = await services.isBuyerFacingChipsEnabled();
    if (!enabled) {
      return c.json({
        sellerAccountId: c.req.param("accountId"),
        shipsOnTime: null,
        lowCancellationRate: null,
        lowDisputeRate: null,
      });
    }

    const chips = await services.getPublicBehavioralMetricsChips(c.req.param("accountId"));
    return c.json(chips);
  });

  return app;
}

export function createAccountSellerMetricsRoutes(services: SellerMetricsServices) {
  const app = new Hono<SellerMetricsApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.sellerMetrics.api.route.authentication.required"),
          },
        },
        401,
      );
    }
    if (!actor.permissions.includes("listings.view")) {
      return c.json(
        {
          error: {
            code: "authorization_forbidden",
            message: t("marketplace.features.sellerMetrics.api.route.forbidden"),
          },
        },
        403,
      );
    }

    const summary = await services.getOwnBehavioralMetrics(actor.accountId);
    return c.json(
      summary ?? {
        seller_account_id: actor.accountId,
        window_days: 0,
        orders_created_count: 0,
        seller_cancelled_count: 0,
        cancellation_rate: null,
        shipments_dispatched_count: 0,
        shipments_on_time_count: 0,
        on_time_shipment_rate: null,
        disputes_resolved_count: 0,
        disputes_against_seller_count: 0,
        dispute_rate: null,
        computed_at: null,
        updated_at: null,
      },
    );
  });

  return app;
}
