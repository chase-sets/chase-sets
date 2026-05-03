import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import {
  MarketplaceFeeQuoteStaleError,
  type MarketplaceListingServices,
} from "./runtime";

function requireListingAccess(
  c: {
    get(key: "actor"): MarketplaceApiEnv["Variables"]["actor"];
  },
  permission: "listings.view" | "listings.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authentication_required", message: t("marketplace.features.listings.api.route.authentication.required") } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({ error: { code: "authorization_forbidden", message: t("marketplace.features.listings.api.route.forbidden") } }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("marketplace.features.listings.api.route.request.failed");
}

function validationError(error: unknown) {
  if (error instanceof MarketplaceFeeQuoteStaleError) {
    return new Response(
      JSON.stringify({
        error: {
          code: "fee_quote_stale",
          message: error.message,
          currentQuote: error.currentQuote,
        },
      }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return null;
}

export function createAccountListingRoutes(services: MarketplaceListingServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/listings", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSellerListings({
      accountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/listing-inventory", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const catalogItemId = c.req.query("catalogItemId");
    const result = await services.listSellerInventoryItemSupply({
      accountId: access.actor.accountId,
      catalogItemId: catalogItemId && catalogItemId.trim() ? catalogItemId : undefined,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.post("/listings/preview", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const preview = await services.previewListingTerms({
        accountId: access.actor.accountId,
        priceAmount: String(body.priceAmount ?? ""),
      });

      return c.json(preview);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/listings/:id", async (c) => {
    const access = requireListingAccess(c, "listings.view");
    if (access.response) {
      return access.response;
    }

    const listing = await services.getSellerListing(
      c.req.param("id"),
      access.actor.accountId,
    );

    if (!listing) {
      return c.json({ error: { code: "not_found", message: t("marketplace.features.listings.api.route.listing.not.found") } }, 404);
    }

    return c.json(listing);
  });

  app.post("/listings", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("marketplace.features.listings.api.route.authentication.context.missing") } }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.createListing(
        {
          accountId: access.actor.accountId as never,
          inventoryItemId: String(body.inventoryItemId ?? ""),
          priceAmount: String(body.priceAmount ?? ""),
          quantityCap: Number(body.quantityCap ?? 0),
        },
        context,
      );

      return c.json(
        {
          id: result.listingId,
          version: result.version,
          status: "draft",
          feeQuoteFingerprint: result.feeQuoteFingerprint,
        },
        201,
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/price", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("marketplace.features.listings.api.route.authentication.context.missing.2") } }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.updateListingPrice(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          priceAmount: String(body.priceAmount ?? ""),
          feeQuoteFingerprint:
            typeof body.feeQuoteFingerprint === "string" ? body.feeQuoteFingerprint : null,
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "price-updated" });
    } catch (error) {
      const response = validationError(error);
      if (response) {
        return response;
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/quantity-cap", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("marketplace.features.listings.api.route.authentication.context.missing.3") } }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.updateListingQuantityCap(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          quantityCap: Number(body.quantityCap ?? 0),
          feeQuoteFingerprint:
            typeof body.feeQuoteFingerprint === "string" ? body.feeQuoteFingerprint : null,
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "quantity-cap-updated" });
    } catch (error) {
      const response = validationError(error);
      if (response) {
        return response;
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/publish", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("marketplace.features.listings.api.route.authentication.context.missing.4") } }, 401);
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await services.publishListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          feeQuoteFingerprint:
            typeof body.feeQuoteFingerprint === "string" ? body.feeQuoteFingerprint : null,
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "published" });
    } catch (error) {
      const response = validationError(error);
      if (response) {
        return response;
      }
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/pause", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("marketplace.features.listings.api.route.authentication.context.missing.5") } }, 401);
    }

    try {
      const result = await services.pauseListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "paused" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/listings/:id/withdraw", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("marketplace.features.listings.api.route.authentication.context.missing.6") } }, 401);
    }

    try {
      const result = await services.withdrawListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version, status: "withdrawn" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

export function createPublicListingRoutes(services: MarketplaceListingServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/products/:productId/market-summary", async (c) => {
    const summary = await services.getMarketSummaryForItem(
      c.req.param("productId"),
    );
    return c.json(summary);
  });

  app.get("/products/:productId/listings", async (c) => {
    const items = await services.listItemListings(
      c.req.param("productId"),
    );
    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  return app;
}
