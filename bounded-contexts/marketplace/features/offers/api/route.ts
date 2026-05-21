import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import { MarketplaceOfferFeeQuoteStaleError, type MarketplaceOfferServices } from "./runtime";

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
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("marketplace.features.offers.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authorization_forbidden", message: t("marketplace.features.offers.api.route.forbidden") },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function requireSignedInAccount(c: { get(key: "actor"): MarketplaceApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("marketplace.features.offers.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("marketplace.features.offers.api.route.request.failed");
}

function validationError(
  c: {
    json: (body: unknown, status?: number) => Response;
  },
  error: unknown,
) {
  if (error instanceof MarketplaceOfferFeeQuoteStaleError) {
    return c.json(
      {
        error: {
          code: "fee_quote_stale",
          message: error.message,
          currentQuote: error.currentQuote,
        },
      },
      409,
    );
  }

  return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
}

function parseVersionSelection(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((selection): selection is { dimensionId: string; optionId: string } =>
          Boolean(selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

function parseShippingDestination(value: unknown) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    name: String(source.name ?? ""),
    company: source.company == null ? null : String(source.company),
    line1: String(source.line1 ?? ""),
    line2: source.line2 == null ? null : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
    phone: source.phone == null ? null : String(source.phone),
    email: source.email == null ? null : String(source.email),
  };
}

export function createAccountSubmittedOfferRoutes(services: MarketplaceOfferServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/offers/submitted", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSubmittedOffers({
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

  app.get("/offers/submitted/:id", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const offer = await services.getSubmittedOffer(c.req.param("id"), access.actor.accountId);

    if (!offer) {
      return c.json(
        { error: { code: "not_found", message: t("marketplace.features.offers.api.route.submitted.offer.not.found") } },
        404,
      );
    }

    return c.json(offer);
  });

  app.post("/offers/submitted", async (c) => {
    const access = requireSignedInAccount(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.offers.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.submitOffer(
        {
          offerId: typeof body.offerId === "string" && body.offerId.trim() ? (body.offerId as never) : undefined,
          buyerAccountId: access.actor.accountId as never,
          catalogItemId: String(body.catalogItemId ?? ""),
          productId: String(body.productId ?? ""),
          itemTitle: String(body.itemTitle ?? ""),
          itemSubtitle:
            body.itemSubtitle === null || body.itemSubtitle === undefined ? null : String(body.itemSubtitle),
          selectedOptions: parseVersionSelection(body.selectedOptions),
          productSummary:
            body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
          shippingDestinationSnapshot: parseShippingDestination(body.shippingDestinationSnapshot),
          priceAmount: String(body.priceAmount ?? ""),
          quantityRequested: Number(body.quantityRequested ?? 0),
        },
        context,
      );

      return c.json({ id: result.offerId, version: result.version, status: "submitted" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

export function createAccountOfferMatchRoutes(services: MarketplaceOfferServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/offers/matches", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listOfferMatches({
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

  app.get("/offers/matches/:id", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const offer = await services.getOfferMatch(c.req.param("id"), access.actor.accountId);

    if (!offer) {
      return c.json(
        { error: { code: "not_found", message: t("marketplace.features.offers.api.route.offer.match.not.found") } },
        404,
      );
    }

    return c.json(offer);
  });

  app.get("/offers/matches/:id/terms-preview", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json(
        { error: { code: "authorization_forbidden", message: t("marketplace.features.offers.api.route.forbidden.2") } },
        403,
      );
    }

    try {
      const quote = await services.previewOfferAcceptanceTerms({
        offerId: c.req.param("id") as never,
        sellerAccountId: access.actor.accountId as never,
      });

      return c.json(quote);
    } catch (error) {
      return validationError(c, error);
    }
  });

  app.post("/offers/matches/:id/accept", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json(
        { error: { code: "authorization_forbidden", message: t("marketplace.features.offers.api.route.forbidden.2") } },
        403,
      );
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.offers.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await services.acceptOffer(
        {
          offerId: c.req.param("id") as never,
          sellerAccountId: access.actor.accountId as never,
          feeQuoteFingerprint:
            body && typeof body === "object" && "feeQuoteFingerprint" in body
              ? String(body.feeQuoteFingerprint ?? "")
              : null,
        },
        context,
      );

      return c.json({ id: result.offerId, version: result.version, status: "accepted" }, 201);
    } catch (error) {
      return validationError(c, error);
    }
  });

  app.get("/offers/match-sell-list", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json(
        { error: { code: "authorization_forbidden", message: t("marketplace.features.offers.api.route.forbidden.3") } },
        403,
      );
    }

    const items = await services.listOfferMatchSellList(access.actor.accountId);

    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  app.post("/offers/match-sell-list", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json(
        { error: { code: "authorization_forbidden", message: t("marketplace.features.offers.api.route.forbidden.4") } },
        403,
      );
    }

    const body = await c.req.json();

    try {
      await services.addOfferMatchSellListItem({
        sellerAccountId: access.actor.accountId as never,
        offerId: String(body.offerId ?? "") as never,
      });

      return c.json({ id: String(body.offerId ?? ""), status: "selected" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/offers/match-sell-list/accept", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }

    if (!access.actor.permissions.includes("listings.view")) {
      return c.json(
        { error: { code: "authorization_forbidden", message: t("marketplace.features.offers.api.route.forbidden.5") } },
        403,
      );
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.offers.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await services.acceptOfferMatchSellList(
        {
          sellerAccountId: access.actor.accountId as never,
          feeQuoteFingerprintsByOfferId:
            body &&
            typeof body === "object" &&
            "feeQuoteFingerprintsByOfferId" in body &&
            body.feeQuoteFingerprintsByOfferId &&
            typeof body.feeQuoteFingerprintsByOfferId === "object"
              ? (body.feeQuoteFingerprintsByOfferId as Record<string, string>)
              : undefined,
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
