import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { formatMoney, t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseOptionalTypedIdBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { MarketplaceApiEnv } from "../../../api";
import {
  MarketplaceOfferAbuseControlError,
  MarketplaceOfferAcceptanceReadinessError,
  MarketplaceOfferFeeQuoteStaleError,
  type MarketplaceOfferServices,
} from "./runtime";
import type { AccountId, OfferId } from "@chase-sets/primitives/typed-ids";
import { omitPrivateOfferResponseFields, publicOfferListResponse } from "./response-shape";

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

  if (error instanceof MarketplaceOfferAcceptanceReadinessError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      409,
    );
  }

  if (error instanceof MarketplaceOfferAbuseControlError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: offerAbuseControlMessage(error),
          details: error.details,
        },
      },
      400,
    );
  }

  return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
}

function offerAbuseControlMessage(error: MarketplaceOfferAbuseControlError) {
  switch (error.code) {
    case "offer_daily_submission_cap_reached":
      return t("marketplace.features.offers.api.route.offer.daily.submission.cap.reached", {
        limit: String(error.details.limit ?? ""),
      });
    case "offer_listing_submission_cap_reached":
      return t("marketplace.features.offers.api.route.offer.listing.submission.cap.reached", {
        limit: String(error.details.limit ?? ""),
      });
    case "offer_price_floor_not_met":
      return t("marketplace.features.offers.api.route.offer.price.floor.not.met", {
        amount: formatMoney(String(error.details.minimumOfferAmount ?? "0.00"), "USD"),
      });
    case "offer_lowball_cooldown":
      return t("marketplace.features.offers.api.route.offer.lowball.cooldown");
    case "offer_muted_by_sellers":
      return t("marketplace.features.offers.api.route.offer.muted.by.sellers");
    default:
      return error.message;
  }
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

const offerSubmissionAccountRateLimiter = createConfiguredInMemoryRateLimiter("marketplace.offer.submit.account", {
  max: 50,
  windowMs: 24 * 60 * 60 * 1000,
});

const offerSubmissionIpRateLimiter = createConfiguredInMemoryRateLimiter("marketplace.offer.submit.ip", {
  max: 20,
  windowMs: 60 * 60 * 1000,
});

const offerAcceptanceAccountRateLimiter = createConfiguredInMemoryRateLimiter("marketplace.offer.accept.account", {
  max: 100,
  windowMs: 24 * 60 * 60 * 1000,
});

const offerAcceptanceIpRateLimiter = createConfiguredInMemoryRateLimiter("marketplace.offer.accept.ip", {
  max: 60,
  windowMs: 60 * 60 * 1000,
});

function rateLimitAccountCommand(
  request: Request,
  accountId: string,
  limiters: Readonly<{
    accountSurface: string;
    ipSurface: string;
    account: ReturnType<typeof createConfiguredInMemoryRateLimiter>;
    ip: ReturnType<typeof createConfiguredInMemoryRateLimiter>;
  }>,
) {
  const accountDecision = limiters.account.check(`account:${accountId}`);
  if (accountDecision.limited) {
    return rateLimitExceededJsonResponse(limiters.accountSurface, accountDecision);
  }

  const ipDecision = limiters.ip.check(publicClientRequestKey(request));
  if (ipDecision.limited) {
    return rateLimitExceededJsonResponse(limiters.ipSurface, ipDecision);
  }

  return null;
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

    const response = publicOfferListResponse(result);

    return c.json({
      ...response,
      count: response.items.length,
    });
  });

  app.get("/offers/submitted/:id", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const offer = await services.getSubmittedOffer(
      parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
      access.actor.accountId,
    );

    if (!offer) {
      return c.json(
        { error: { code: "not_found", message: t("marketplace.features.offers.api.route.submitted.offer.not.found") } },
        404,
      );
    }

    return c.json(omitPrivateOfferResponseFields(offer));
  });

  app.post("/offers/submitted", async (c) => {
    const access = requireSignedInAccount(c);
    if (access.response) {
      return access.response;
    }
    const rateLimited = rateLimitAccountCommand(c.req.raw, access.actor.accountId, {
      accountSurface: "marketplace.offer.submit.account",
      ipSurface: "marketplace.offer.submit.ip",
      account: offerSubmissionAccountRateLimiter,
      ip: offerSubmissionIpRateLimiter,
    });
    if (rateLimited) {
      return rateLimited;
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
          offerId: parseOptionalTypedIdBoundary(body.offerId, "off", "offerId"),
          buyerAccountId: access.actor.accountId as AccountId,
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
      return validationError(c, error);
    }
  });

  return app;
}

export function createAccountOfferMatchRoutes(services: MarketplaceOfferServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.get("/offers/public/:id", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const offer = await services.getPublicOffer(parseTypedIdBoundary(c.req.param("id"), "off", "offerId"));

    if (!offer) {
      return c.json(
        { error: { code: "not_found", message: t("marketplace.features.offers.api.route.offer.not.found") } },
        404,
      );
    }

    return c.json(omitPrivateOfferResponseFields(offer));
  });

  app.get("/offers/matches", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const productIds = String(c.req.query("productIds") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const result = await services.listOfferMatches({
      sellerAccountId: access.actor.accountId,
      limit,
      offset,
      productIds,
      status: c.req.query("status") === "submitted" ? "submitted" : undefined,
      canFulfill: c.req.query("canFulfill") === "true" ? true : undefined,
    });

    const response = publicOfferListResponse(result);

    return c.json({
      ...response,
      count: response.items.length,
    });
  });

  app.get("/offers/mutes", async (c) => {
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

    const result = await services.listOfferBuyerMutes(access.actor.accountId);

    return c.json({
      ...result,
      count: result.items.length,
    });
  });

  app.get("/offers/matches/:id", async (c) => {
    const access = requireOfferAccess(c, "offers.view");
    if (access.response) {
      return access.response;
    }

    const offer = await services.getOfferMatch(
      parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
      access.actor.accountId,
    );

    if (!offer) {
      return c.json(
        { error: { code: "not_found", message: t("marketplace.features.offers.api.route.offer.match.not.found") } },
        404,
      );
    }

    return c.json(omitPrivateOfferResponseFields(offer));
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
        offerId: parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
        sellerAccountId: access.actor.accountId as AccountId,
        listingId: parseTypedIdBoundary(c.req.query("listingId") ?? "", "lst", "listingId"),
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
    const rateLimited = rateLimitAccountCommand(c.req.raw, access.actor.accountId, {
      accountSurface: "marketplace.offer.accept.account",
      ipSurface: "marketplace.offer.accept.ip",
      account: offerAcceptanceAccountRateLimiter,
      ip: offerAcceptanceIpRateLimiter,
    });
    if (rateLimited) {
      return rateLimited;
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
          offerId: parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
          sellerAccountId: access.actor.accountId as AccountId,
          listingId: parseTypedIdBoundary(
            body && typeof body === "object" && "listingId" in body ? String(body.listingId ?? "") : "",
            "lst",
            "listingId",
          ),
          feeQuoteFingerprint:
            body && typeof body === "object" && "feeQuoteFingerprint" in body
              ? String(body.feeQuoteFingerprint ?? "")
              : null,
          sourceActionKey:
            body && typeof body === "object" && "sourceActionKey" in body ? String(body.sourceActionKey ?? "") : null,
          acceptanceBatchId:
            body && typeof body === "object" && "acceptanceBatchId" in body
              ? String(body.acceptanceBatchId ?? "")
              : null,
          acceptanceBatchSize:
            body && typeof body === "object" && "acceptanceBatchSize" in body ? Number(body.acceptanceBatchSize) : null,
        },
        context,
      );

      return c.json(
        {
          id: result.offerId,
          listingId: result.listingId,
          inventoryItemId: result.inventoryItemId,
          evidenceSnapshotHash: result.listingEvidenceSnapshot.snapshotHash,
          version: result.version,
          status: "accepted",
        },
        201,
      );
    } catch (error) {
      return validationError(c, error);
    }
  });

  app.post("/offers/matches/:id/decline", async (c) => {
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
      const result = await services.declineOfferMatch(
        {
          offerId: parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
          sellerAccountId: access.actor.accountId as AccountId,
        },
        context,
      );

      return c.json({ id: result.offerId, version: result.version, status: "declined" }, 201);
    } catch (error) {
      return validationError(c, error);
    }
  });

  app.post("/offers/matches/:id/mute-buyer", async (c) => {
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
      const result = await services.muteBuyerOffers(
        {
          offerId: parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
          sellerAccountId: access.actor.accountId as AccountId,
        },
        context,
      );

      return c.json({ id: result.offerId, version: result.version, status: "muted" }, 201);
    } catch (error) {
      return validationError(c, error);
    }
  });

  app.post("/offers/mutes/:listingId/:buyerAccountId/unmute", async (c) => {
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
      const result = await services.unmuteBuyerOffers(
        {
          listingId: c.req.param("listingId"),
          buyerAccountId: parseTypedIdBoundary(c.req.param("buyerAccountId"), "acc", "buyerAccountId"),
          sellerAccountId: access.actor.accountId as AccountId,
        },
        context,
      );

      return c.json(
        {
          listingId: result.listingId,
          buyerAccountId: result.buyerAccountId,
          version: result.version,
          status: "unmuted",
        },
        201,
      );
    } catch (error) {
      return validationError(c, error);
    }
  });

  return app;
}
