import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import type { MarketplaceOfferServices } from "./runtime";

function requireOfferAccess(
  c: {
    get(key: "actor"): MarketplaceApiEnv["Variables"]["actor"];
  },
  permission: "offers.view" | "offers.manage",
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
      response: new Response(JSON.stringify({ error: "Forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function parseVersionSelection(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter(
          (selection): selection is { dimensionId: string; optionId: string } =>
            Boolean(
              selection &&
              typeof selection === "object" &&
              "dimensionId" in selection &&
              "optionId" in selection,
            ),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

export function createSubmittedBuyerOfferRoutes(services: MarketplaceOfferServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/submitted-buyer-offers", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSubmittedBuyerOffers({
      buyerAccountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/submitted-buyer-offers/:id", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const offer = await services.getSubmittedBuyerOffer(
      c.req.param("id"),
      access.actor.accountId,
    );

    if (!offer) {
      return c.json({ error: "Submitted buyer offer not found." }, 404);
    }

    return c.json(offer);
  });

  app.post("/submitted-buyer-offers", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.submitOffer(
        {
          buyerAccountId: access.actor.accountId as never,
          catalogItemId: String(body.catalogItemId ?? ""),
          productId: String(body.productId ?? ""),
          itemTitle: String(body.itemTitle ?? ""),
          itemSubtitle:
            body.itemSubtitle === null || body.itemSubtitle === undefined
              ? null
              : String(body.itemSubtitle),
          selectedOptions: parseVersionSelection(body.selectedOptions),
          productSummary:
            body.productSummary === null || body.productSummary === undefined
              ? null
              : String(body.productSummary),
          priceAmount: String(body.priceAmount ?? ""),
          quantityRequested: Number(body.quantityRequested ?? 0),
        },
        context,
      );

      return c.json({ id: result.offerId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}

export function createBuyerOfferMatchRoutes(services: MarketplaceOfferServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/buyer-offer-matches", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listBuyerOfferMatches({
      sellerAccountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/buyer-offer-matches/:id", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const offer = await services.getBuyerOfferMatch(
      c.req.param("id"),
      access.actor.accountId,
    );

    if (!offer) {
      return c.json({ error: "Buyer offer match not found." }, 404);
    }

    return c.json(offer);
  });

  app.post("/buyer-offer-matches/:id/accept", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json({ error: "Forbidden." }, 403);
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.acceptOffer(
        {
          offerId: c.req.param("id") as never,
          sellerAccountId: access.actor.accountId as never,
        },
        context,
      );

      return c.json({ id: result.offerId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/buyer-offer-match-sell-list", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json({ error: "Forbidden." }, 403);
    }

    const items = await services.listBuyerOfferMatchSellList(access.actor.accountId);

    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  app.post("/buyer-offer-match-sell-list", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json({ error: "Forbidden." }, 403);
    }

    const body = await c.req.json();

    try {
      await services.addBuyerOfferMatchSellListItem({
        sellerAccountId: access.actor.accountId as never,
        offerId: String(body.offerId ?? "") as never,
      });

      return c.json({ id: String(body.offerId ?? "") }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/buyer-offer-match-sell-list/accept", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json({ error: "Forbidden." }, 403);
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.acceptBuyerOfferMatchSellList(
        {
          sellerAccountId: access.actor.accountId as never,
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
