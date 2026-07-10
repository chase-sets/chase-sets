import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { DiscoveryItemDetailServices } from "./runtime";

export function discoveryItemDetailRoutes(services: DiscoveryItemDetailServices) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.get("/:id/similar", async (c) => {
    const result = await services.findSimilarItems(c.req.param("id"), {
      limit: readSimilarItemsLimit(c.req.query("limit")),
    });

    if (!result) {
      return c.json(
        { error: { code: "not_found", message: t("discovery.features.itemDetail.api.route.item.not.found") } },
        404,
      );
    }

    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json(result);
  });

  app.get("/:id/seller-overlay", async (c) => {
    const actor = c.get("actor");

    if (!actor) {
      return c.json(
        { error: { code: "unauthenticated", message: t("discovery.features.itemDetail.api.route.auth.required") } },
        401,
      );
    }

    const item = await services.getItemDetail(c.req.param("id"));

    if (!item) {
      return c.json(
        { error: { code: "not_found", message: t("discovery.features.itemDetail.api.route.item.not.found") } },
        404,
      );
    }

    const canReviewAccountOfferMatches =
      actor.permissions.includes("offers.view") && actor.permissions.includes("listings.view");
    const canSellOnItem = actor.permissions.includes("listings.view") && actor.permissions.includes("listings.manage");

    if (!canReviewAccountOfferMatches && !canSellOnItem) {
      return c.json(
        { error: { code: "forbidden", message: t("discovery.features.itemDetail.api.route.forbidden") } },
        403,
      );
    }

    const overlay = await services.getSellerOverlay({
      accountId: actor.accountId,
      catalogItemId: item.catalog_item_id,
      selectedListingId: c.req.query("selectedListingId") ?? null,
    });

    return c.json({
      accountOfferMatches: canReviewAccountOfferMatches ? overlay.accountOfferMatches : [],
      sellerInventoryItems: canSellOnItem ? overlay.sellerInventoryItems : [],
      hasListingStockLocation: canSellOnItem ? overlay.hasListingStockLocation : false,
      selectedSellerListing: canSellOnItem ? overlay.selectedSellerListing : null,
    });
  });

  app.get("/:id", async (c) => {
    const item = await services.getItemDetail(c.req.param("id"));

    if (!item) {
      return c.json(
        { error: { code: "not_found", message: t("discovery.features.itemDetail.api.route.item.not.found") } },
        404,
      );
    }

    return c.json(item);
  });

  return app;
}

function readSimilarItemsLimit(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
