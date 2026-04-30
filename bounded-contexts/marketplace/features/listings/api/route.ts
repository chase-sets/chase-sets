import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import type { MarketplaceListingServices } from "./runtime";

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
      response: new Response(JSON.stringify({ error: "Authentication required." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({ error: "Forbidden." }),
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
  return error instanceof Error ? error.message : "Request failed.";
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

    const body = await c.req.json();

    try {
      const preview = await services.previewListingTerms({
        accountId: access.actor.accountId,
        priceAmount: String(body.priceAmount ?? ""),
      });

      return c.json(preview);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
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
      return c.json({ error: "Listing not found." }, 404);
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
      return c.json({ error: "Authentication context missing." }, 401);
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

      return c.json({ id: result.listingId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/listings/:id/price", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.updateListingPrice(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          priceAmount: String(body.priceAmount ?? ""),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/listings/:id/quantity-cap", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.updateListingQuantityCap(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
          quantityCap: Number(body.quantityCap ?? 0),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/listings/:id/publish", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.publishListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/listings/:id/pause", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.pauseListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/listings/:id/withdraw", async (c) => {
    const access = requireListingAccess(c, "listings.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.withdrawListing(
        {
          accountId: access.actor.accountId,
          listingId: c.req.param("id"),
        },
        context,
      );

      return c.json({ id: result.listingId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
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
