import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import { parseOptionalTypedIdBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { MarketplaceApiEnv } from "../../../api";
import {
  MARKETPLACE_OFFER_BULK_LIFECYCLE_LIMIT,
  MarketplaceOfferAbuseControlError,
  MarketplaceOfferAcceptanceReadinessError,
  MarketplaceOfferFeeQuoteStaleError,
  MarketplaceOfferLifecycleError,
  type MarketplaceOfferServices,
} from "./runtime";
import type { AccountId, OfferId } from "@chase-sets/primitives/typed-ids";
import { omitPrivateOfferResponseFields, publicOfferListResponse } from "./response-shape";
import { ManagedOfferConflictError } from "./managed-authority";
import { MarketplaceAttemptError } from "../../mutation-recovery/api/attempt";
import { marketplaceReceiptResponse } from "../../mutation-recovery/api/receipt";
import { parseSubmittedOfferStatus } from "../read-model/queries";
import type { OfferLifecycleAction } from "../domain/domain";
import { MarketplaceOfferLifecycleClosedError } from "./lifecycle-admission";

const offerLifecycleActions = ["pause", "resume", "withdraw"] as const satisfies readonly OfferLifecycleAction[];

function lifecycleClosedResponse(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json(
    {
      error: {
        code: "offer_lifecycle_closed",
        message: t("marketplace.features.offers.api.route.offer.lifecycle.closed"),
      },
    },
    503,
  );
}

function lifecycleErrorResponse(c: { json: (body: unknown, status?: number) => Response }, error: unknown) {
  if (error instanceof MarketplaceOfferLifecycleClosedError) return lifecycleClosedResponse(c);
  if (!(error instanceof MarketplaceOfferLifecycleError)) return validationError(c, error);
  if (error.code === "not_found")
    return c.json(
      { error: { code: error.code, message: t("marketplace.features.offers.api.route.submitted.offer.not.found") } },
      404,
    );
  return c.json(
    {
      error: {
        code: error.code,
        message:
          error.code === "offer_conflict"
            ? t("marketplace.features.offers.api.route.offer.conflict")
            : t("marketplace.features.offers.api.route.offer.transition.rejected"),
      },
    },
    409,
  );
}

function parseBulkLifecycleRequest(body: unknown) {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const action = offerLifecycleActions.find((candidate) => candidate === source.action);
  const offerIds = source.offerIds;
  if (
    !action ||
    !Array.isArray(offerIds) ||
    offerIds.length === 0 ||
    offerIds.length > MARKETPLACE_OFFER_BULK_LIFECYCLE_LIMIT
  )
    return null;
  return { action, offerIds: offerIds.map((id, index) => parseTypedIdBoundary(id, "off", `offerIds[${index}]`)) };
}

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
  if (error instanceof MarketplaceAttemptError)
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.code === "invalid_attempt" ? 400 : 409,
    );
  if (error instanceof ManagedOfferConflictError)
    return c.json({ error: { code: error.code, message: error.message } }, 409);
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
      status: parseSubmittedOfferStatus(c.req.query("status")),
    });

    const response = publicOfferListResponse(result);

    return c.json({
      ...response,
      count: response.items.length,
      statusCounts: result.statusCounts,
    });
  });

  app.post("/offers/submitted/bulk", async (c) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.offers.api.route.authentication.required"),
          },
        },
        401,
      );
    }
    let request: ReturnType<typeof parseBulkLifecycleRequest>;
    try {
      request = parseBulkLifecycleRequest(await c.req.json().catch(() => null));
    } catch (error) {
      return validationError(c, error);
    }
    if (!request) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("marketplace.features.offers.api.route.bulk.invalid", {
              limit: String(MARKETPLACE_OFFER_BULK_LIFECYCLE_LIMIT),
            }),
          },
        },
        400,
      );
    }
    let items: Awaited<ReturnType<MarketplaceOfferServices["bulkChangeOfferLifecycle"]>>;
    try {
      items = await services.bulkChangeOfferLifecycle(
        { buyerAccountId: access.actor.accountId as AccountId, action: request.action, offerIds: request.offerIds },
        context,
      );
    } catch (error) {
      if (error instanceof MarketplaceOfferLifecycleClosedError) return lifecycleClosedResponse(c);
      throw error;
    }
    return c.json({ action: request.action, items, total: items.length, count: items.length });
  });

  const changeLifecycle = (action: OfferLifecycleAction) => async (c: Context<MarketplaceApiEnv>) => {
    const access = requireOfferAccess(c, "offers.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.offers.api.route.authentication.required"),
          },
        },
        401,
      );
    }
    try {
      const result = await services.changeOfferLifecycle(
        {
          offerId: parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
          buyerAccountId: access.actor.accountId as AccountId,
          action,
        },
        context,
      );
      return c.json({ id: result.offerId, version: result.version, status: result.status, outcome: result.outcome });
    } catch (error) {
      return lifecycleErrorResponse(c, error);
    }
  };
  app.post("/offers/submitted/:id/pause", changeLifecycle("pause"));
  app.post("/offers/submitted/:id/resume", changeLifecycle("resume"));
  app.post("/offers/submitted/:id/withdraw", changeLifecycle("withdraw"));

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
          attemptId: String(body.attemptId ?? ""),
          ...(body.requestHash === undefined ? {} : { requestHash: String(body.requestHash) }),
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
          priceCurrencyCode: String(body.priceCurrencyCode ?? ""),
          quantityRequested: Number(body.quantityRequested ?? 0),
        },
        context,
      );

      return marketplaceReceiptResponse(
        c.json({ id: result.offerId, version: result.version, status: "submitted" }, 201),
        result,
      );
    } catch (error) {
      return validationError(c, error);
    }
  });

  app.patch("/offers/submitted/:id/price", async (c) => {
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
            message: t("marketplace.features.offers.api.route.authentication.required"),
          },
        },
        401,
      );
    }
    const body = await c.req.json();
    try {
      const result = await services.updateOfferPrice(
        {
          attemptId: String(body.attemptId ?? ""),
          ...(body.requestHash === undefined ? {} : { requestHash: String(body.requestHash) }),
          offerId: parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
          buyerAccountId: access.actor.accountId as AccountId,
          priceAmount: String(body.priceAmount ?? ""),
          priceCurrencyCode: String(body.priceCurrencyCode ?? ""),
        },
        context,
      );
      return marketplaceReceiptResponse(
        c.json({ id: result.offerId, version: result.version, status: result.status }),
        result,
      );
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
            body && typeof body === "object" && "sourceActionKey" in body ? String(body.sourceActionKey ?? "") : "",
          ...(body.requestHash === undefined ? {} : { requestHash: String(body.requestHash) }),
          acceptanceBatchId:
            body && typeof body === "object" && "acceptanceBatchId" in body
              ? String(body.acceptanceBatchId ?? "")
              : null,
          acceptanceBatchSize:
            body && typeof body === "object" && "acceptanceBatchSize" in body ? Number(body.acceptanceBatchSize) : null,
        },
        context,
      );

      return marketplaceReceiptResponse(
        c.json(
          {
            id: result.offerId,
            listingId: result.listingId,
            inventoryItemId: result.inventoryItemId,
            evidenceSnapshotHash: result.listingEvidenceSnapshot.snapshotHash,
            version: result.version,
            status: "accepted",
          },
          201,
        ),
        result,
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
      const body = await c.req.json();
      const result = await services.declineOfferMatch(
        {
          attemptId: String(body.attemptId ?? ""),
          ...(body.requestHash === undefined ? {} : { requestHash: String(body.requestHash) }),
          offerId: parseTypedIdBoundary(c.req.param("id"), "off", "offerId"),
          sellerAccountId: access.actor.accountId as AccountId,
        },
        context,
      );

      return marketplaceReceiptResponse(
        c.json({ id: result.offerId, version: result.version, status: "declined" }, 201),
        result,
      );
    } catch (error) {
      return validationError(c, error);
    }
  });

  return app;
}
