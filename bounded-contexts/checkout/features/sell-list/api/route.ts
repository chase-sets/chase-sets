import { createMarketplaceRequestApiClient } from "../integrations/marketplace/request-support/api-client";
import { SellListHandoffInterruptedError } from "./marketplace-handoff";
import { SellListPreparationRefusedError, SellListReviewPlanStaleError } from "./handoff-contracts";
import { parseSellListReviewSelections } from "./review-plan-selections";
import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import { computeCheckoutCommandAttemptRequestHash } from "../../command-attempts/api/contracts";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { parseTypedIdBoundary, TypedIdBoundaryDomainError } from "@chase-sets/http/typed-id";
import type { SellListLineId } from "../../../support/runtime-support/common";
import type { CheckoutApiEnv } from "../../../api";
import {
  anonymousRequestRateLimitedResponse,
  createAnonymousRailCaptureRateLimiter,
  createCheckoutAccessGuard,
  createGuestCheckoutContext,
} from "../../../support/request-support/checkout-route-guard";
import { parseSellListReadinessDecisionInput } from "../domain/readiness";
import { parseSellerCheckoutChoices } from "../read-model/seller-checkout-owner-reads";
import type { CheckoutObservabilityTelemetry } from "../../sessions/api/checkout-observability-telemetry";
import type { CheckoutSellListServices } from "./runtime";
import { recordSellListConfirmationActivity } from "./sell-list-confirmation-observability";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";

const MAX_ANONYMOUS_SELL_LIST_LINES = 50;
const requireSellListAccess = createCheckoutAccessGuard({
  authenticationRequiredMessage: t("checkout.features.cart.api.route.authentication.required"),
  authorizationForbiddenMessage: t("checkout.features.sellList.api.route.sell.list.review.requires.seller.account"),
});
const createGuestSellListContext = () =>
  createGuestCheckoutContext({
    performedByUserId: "usr_anonymous_sell_list" as UserId,
    forAccountId: "acc_anonymous_sell_list" as AccountId,
  });

function requireAnonymousSellListId(c: { req: { header: (name: string) => string | undefined } }) {
  const ownerId = c.req.header("x-checkout-anonymous-sell-list-id")?.trim() ?? "";
  if (!ownerId.startsWith("anon_")) {
    return null;
  }

  return ownerId;
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.sellList.api.route.sell.list.request.failed");
}

function writeError(c: Context<CheckoutApiEnv>, error: unknown) {
  if (error instanceof SellListHandoffInterruptedError) {
    return c.json(
      {
        error: {
          code: "checkout_handoff_interrupted",
          message: error.message,
          lines: error.lines,
          ...(error.reason instanceof SellListReviewPlanStaleError ? { recovery: error.reason.recovery } : {}),
        },
      },
      409,
    );
  }
  if (error instanceof SellListPreparationRefusedError) {
    return c.json({ error: { code: error.code, message: error.message, reasons: error.reasons } }, 400);
  }
  if (error instanceof TypedIdBoundaryDomainError) return c.json(error.body, 400);
  if (!(error instanceof CheckoutDomainError)) throw error;
  const code = error instanceof CheckoutDomainError ? error.code : "validation_failed";
  return c.json(
    { error: { code, message: errorMessage(error) } },
    code === "checkout_attempt_conflict" || code === "checkout_confirmation_changed" ? 409 : 400,
  );
}

function batchRoutes(services: CheckoutSellListServices, guest = false) {
  return new Hono<CheckoutApiEnv>().post("/sell-list/commands", async (c) => {
    const access = guest ? null : requireSellListAccess(c);
    if (access?.response) return access.response;
    const ownerKey = guest ? requireAnonymousSellListId(c) : access?.actor?.accountId;
    const context = c.get("context") ?? (guest ? createGuestSellListContext() : null);
    if (!ownerKey || !context) return c.json({ error: { code: "authentication_required" } }, 401);
    const body = await c.req.json<Record<string, unknown>>();
    try {
      const lineIds = Array.isArray(body.lineIds) ? body.lineIds : [];
      const attempt = await services.executeSellListAttempt(
        {
          ownerKey,
          attemptId: String(body.attemptId ?? ""),
          kind: "sell-list-batch",
          target: "sell-list",
          requestHash: await computeCheckoutCommandAttemptRequestHash(body),
          commands: lineIds.map((id) => ({
            type: "remove" as const,
            lineId: parseTypedIdBoundary(String(id), "sll", "lineId"),
          })),
        },
        context,
      );
      return c.json(
        { id: ownerKey, version: attempt.vector?.[0]?.version ?? 0, status: attempt.ownerStatus, attempt },
        attempt.ownerStatus === "conflict" ? 409 : 200,
      );
    } catch (error) {
      return writeError(c, error);
    }
  });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseSellListLineBody(body: Record<string, unknown>) {
  return {
    lineType: body.lineType === "selected-offer" ? ("selected-offer" as const) : ("product" as const),
    offerId: body.offerId === null || body.offerId === undefined ? null : String(body.offerId),
    listingId: body.listingId === null || body.listingId === undefined ? null : String(body.listingId),
    buyerAccountId:
      body.buyerAccountId === null || body.buyerAccountId === undefined ? null : String(body.buyerAccountId),
    buyerDisplayName:
      body.buyerDisplayName === null || body.buyerDisplayName === undefined ? null : String(body.buyerDisplayName),
    offerPriceAmount:
      body.offerPriceAmount === null || body.offerPriceAmount === undefined ? null : String(body.offerPriceAmount),
    offerPriceCurrencyCode:
      body.offerPriceCurrencyCode === null || body.offerPriceCurrencyCode === undefined
        ? null
        : String(body.offerPriceCurrencyCode),
    offerStreamVersion:
      body.offerStreamVersion === null || body.offerStreamVersion === undefined
        ? null
        : Number(body.offerStreamVersion),
    listingPriceAmount:
      body.listingPriceAmount === null || body.listingPriceAmount === undefined
        ? null
        : String(body.listingPriceAmount),
    listingPriceCurrencyCode:
      body.listingPriceCurrencyCode === null || body.listingPriceCurrencyCode === undefined
        ? null
        : String(body.listingPriceCurrencyCode),
    listingStreamVersion:
      body.listingStreamVersion === null || body.listingStreamVersion === undefined
        ? null
        : Number(body.listingStreamVersion),
    catalogItemId: String(body.catalogItemId ?? ""),
    productId: String(body.productId ?? ""),
    itemTitle: String(body.itemTitle ?? ""),
    itemSubtitle: body.itemSubtitle === null || body.itemSubtitle === undefined ? null : String(body.itemSubtitle),
    selectedOptions: parseVersionSelection(body.selectedOptions),
    productSummary:
      body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
    quantity: Number(body.quantity ?? 0),
    fallbackMode: body.fallbackMode === "create-listing" ? ("create-listing" as const) : ("none" as const),
    minimumListingPriceAmount:
      body.minimumListingPriceAmount === null || body.minimumListingPriceAmount === undefined
        ? null
        : String(body.minimumListingPriceAmount),
  };
}

function isExistingSellListLine(
  line: Awaited<ReturnType<CheckoutSellListServices["listLines"]>>[number],
  body: ReturnType<typeof parseSellListLineBody>,
) {
  if (body.lineType === "selected-offer" && body.offerId) {
    return line.offer_id === body.offerId;
  }

  return (
    line.line_type === "product" &&
    line.product_id === body.productId &&
    line.fallback_mode === body.fallbackMode &&
    (line.minimum_listing_price_amount ?? null) === (body.minimumListingPriceAmount ?? null)
  );
}

function parseSellListConfirmationBody(body: Record<string, unknown>) {
  const confirmationId = String(body.confirmationId ?? body.confirmation_id ?? "").trim();
  const readinessSnapshotId = String(body.readinessSnapshotId ?? body.readiness_snapshot_id ?? "").trim();
  const readinessSourceRevision = String(body.readinessSourceRevision ?? body.readiness_source_revision ?? "").trim();
  const readinessDecisions = parseSellListReadinessDecisionInput(body.readinessDecisions ?? body.readiness_decisions);

  return {
    confirmationId,
    readinessSnapshotId,
    readinessSourceRevision,
    readinessDecisions,
  };
}

function hasSellListConfirmationEvidence(body: ReturnType<typeof parseSellListConfirmationBody>) {
  return Boolean(body.confirmationId && body.readinessSnapshotId && body.readinessSourceRevision);
}

export function createAccountSellListRoutes(
  services: CheckoutSellListServices,
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
) {
  const app = new Hono<CheckoutApiEnv>().route("/", batchRoutes(services));

  app.get("/sell-list", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const [items, latestConfirmation] = await Promise.all([
      services.listLines(access.actor.accountId),
      services.getLatestConfirmation(access.actor.accountId),
    ]);
    return c.json({
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
      latestConfirmation,
    });
  });

  app.get("/sell-list/payout-readiness", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getPayoutReadiness(access.actor.accountId));
  });

  app.get("/sell-list/ship-from-addresses", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    return c.json({ items: await services.listShipFromAddresses(access.actor.accountId) });
  });

  app.get("/sell-list/composite-review", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    return c.json(
      await services.loadCompositeReview(access.actor.accountId, {
        includeStandardComparison: c.req.query("includeStandardComparison") === "true",
        sellListPath:
          c.req.query("sellListPath") === "/account/desk/offers" ? "/account/desk/offers" : "/account/sell-list",
      }),
    );
  });

  app.get("/sell-list/offer-matches/:offerId", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const offer = await services.getOfferMatch(access.actor.accountId, c.req.param("offerId"));
    if (!offer) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("checkout.features.sellList.api.route.offer.match.not.found"),
          },
        },
        404,
      );
    }

    return c.json(offer);
  });

  app.post("/sell-list/readiness", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json().catch(() => ({}));
    try {
      if (body.selections !== undefined) {
        const context = c.get("context");
        if (!context) throw new CheckoutDomainError("Sell List review requires authenticated context.");
        return c.json(
          await services.createReviewReadiness(
            {
              sellerAccountId: access.actor.accountId,
              selections: parseSellListReviewSelections(body.selections),
            },
            context,
          ),
        );
      }
      if (body.readinessSnapshotId !== undefined || body.readinessSourceRevision !== undefined) {
        return c.json(
          await services.getReviewReadiness({
            sellerAccountId: access.actor.accountId,
            snapshotId: String(body.readinessSnapshotId ?? ""),
            sourceRevision: String(body.readinessSourceRevision ?? ""),
            ...(body.confirmationId ? { confirmationId: String(body.confirmationId) } : {}),
          }),
        );
      }

      const snapshot = await services.createReadinessSnapshot(
        {
          sellerAccountId: access.actor.accountId,
          decisions: parseSellListReadinessDecisionInput(body),
          ...((body as Record<string, unknown>).confirmationId
            ? { confirmationId: String((body as Record<string, unknown>).confirmationId) }
            : {}),
          ...((body as Record<string, unknown>).entryReadinessSnapshotId
            ? { entryReadinessSnapshotId: String((body as Record<string, unknown>).entryReadinessSnapshotId) }
            : {}),
          ...((body as Record<string, unknown>).entryReadinessSourceRevision
            ? { entryReadinessSourceRevision: String((body as Record<string, unknown>).entryReadinessSourceRevision) }
            : {}),
          ...parseSellerCheckoutChoices(body),
        },
        c.get("context") ?? undefined,
      );

      return c.json({ readiness: snapshot });
    } catch (error) {
      return writeError(c, error);
    }
  });

  app.post("/sell-list", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json<Record<string, unknown>>();

    try {
      const result = await services.addLine(
        {
          sellerAccountId: access.actor.accountId as AccountId,
          attemptId: String(body.attemptId ?? ""),
          requestHash: await computeCheckoutCommandAttemptRequestHash(body),
          ...parseSellListLineBody(body),
        },
        context,
      );

      return c.json(
        {
          id: result.lineId,
          version: result.version,
          status: result.status,
          attempt: result.attempt,
          ...(result.commandReceipt ? { commandReceipt: result.commandReceipt } : {}),
        },
        201,
      );
    } catch (error) {
      return writeError(c, error);
    }
  });

  app.get("/sell-list/confirmations/:confirmationId", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const confirmation = await services.getConfirmation(access.actor.accountId, c.req.param("confirmationId"));
    if (!confirmation) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("checkout.features.sellList.api.route.sell.list.confirmation.not.found"),
          },
        },
        404,
      );
    }

    recordSellListConfirmationActivity(checkoutObservabilityTelemetry, access.actor, confirmation);

    return c.json(confirmation);
  });

  app.post("/sell-list/:lineId/remove", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    try {
      const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
      const result = await services.removeLine(
        {
          sellerAccountId: access.actor.accountId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "sll", "lineId"),
          attemptId: String(body.attemptId ?? ""),
          requestHash: await computeCheckoutCommandAttemptRequestHash(body),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed", attempt: result.attempt });
    } catch (error) {
      return writeError(c, error);
    }
  });

  app.post("/sell-list/confirm", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const confirmationBody = parseSellListConfirmationBody(body);

    try {
      if (!hasSellListConfirmationEvidence(confirmationBody)) {
        return c.json(
          {
            error: {
              code: "validation_failed",
              message: t("checkout.features.sellList.api.route.sell.list.confirmation.evidence.required"),
            },
          },
          400,
        );
      }
      const result = await services.confirmSellListCheckout(
        {
          sellerAccountId: access.actor.accountId as AccountId,
          confirmationId: confirmationBody.confirmationId,
          readinessSnapshotId: confirmationBody.readinessSnapshotId,
          readinessSourceRevision: confirmationBody.readinessSourceRevision,
          readinessDecisions: confirmationBody.readinessDecisions,
          ...parseSellerCheckoutChoices(body),
        },
        context,
        createMarketplaceRequestApiClient(c.req.raw),
      );

      return c.json({
        id: result.sellerAccountId,
        confirmationId: confirmationBody.confirmationId,
        version: result.version,
        status: result.status,
        completedLineIds: result.completedLineIds,
        confirmation: result.confirmation,
        sourceReceipts: result.sourceReceipts,
      });
    } catch (error) {
      return writeError(c, error);
    }
  });

  return app;
}

export function createGuestSellListRoutes(
  services: CheckoutSellListServices,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<CheckoutApiEnv>().route("/", batchRoutes(services, true));
  const anonymousSellListCaptureRateLimiter = createAnonymousRailCaptureRateLimiter(
    "checkout:anonymous-sell-list-capture",
    resolveRateLimitRule,
  );

  app.get("/sell-list", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json({ items: [], count: 0 });
    }

    const items = await services.listLines(ownerId);
    return c.json({
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
    });
  });

  app.get("/sell-list/composite-review", async (c) => {
    return c.json(await services.loadGuestCompositeReview(requireAnonymousSellListId(c)));
  });

  app.get("/sell-list/offer-reviews", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json({ offerReviews: [] });
    }

    return c.json({ offerReviews: await services.loadGuestOfferReviews(ownerId) });
  });

  app.post("/sell-list/readiness", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const snapshot = await services.createReadinessSnapshot({
      sellerAccountId: ownerId,
      decisions: parseSellListReadinessDecisionInput(body),
      ...parseSellerCheckoutChoices(body),
    });

    return c.json({ readiness: snapshot });
  });

  app.post("/sell-list", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const rateLimit = await anonymousSellListCaptureRateLimiter.check(c.req.raw);
    if (rateLimit.limited) {
      const response = anonymousRequestRateLimitedResponse(
        t("checkout.features.sellList.api.route.anonymous.request.rate.limited"),
        rateLimit.retryAfterSeconds,
      );
      return c.json(response.body, 429, response.headers);
    }

    const context = c.get("context") ?? createGuestSellListContext();
    const body = await c.req.json<Record<string, unknown>>();
    const line = parseSellListLineBody(body);

    try {
      const result = await services.addLine(
        {
          sellerAccountId: ownerId as AccountId,
          attemptId: String(body.attemptId ?? ""),
          requestHash: await computeCheckoutCommandAttemptRequestHash(body),
          newLineLimit: MAX_ANONYMOUS_SELL_LIST_LINES,
          ...line,
        },
        context,
      );

      return c.json(
        {
          id: result.lineId,
          version: result.version,
          status: result.status,
          attempt: result.attempt,
          ...(result.commandReceipt ? { commandReceipt: result.commandReceipt } : {}),
        },
        201,
      );
    } catch (error) {
      return writeError(c, error);
    }
  });

  app.post("/sell-list/:lineId/remove", async (c) => {
    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_sell_list_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestSellListContext();

    try {
      const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
      const result = await services.removeLine(
        {
          sellerAccountId: ownerId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "sll", "lineId"),
          attemptId: String(body.attemptId ?? ""),
          requestHash: await computeCheckoutCommandAttemptRequestHash(body),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed", attempt: result.attempt });
    } catch (error) {
      return writeError(c, error);
    }
  });

  app.post("/sell-list/merge-to-account", async (c) => {
    const access = requireSellListAccess(c);
    if (access.response) {
      return access.response;
    }

    const ownerId = requireAnonymousSellListId(c);
    if (!ownerId) {
      return c.json({ mergedLineCount: 0 });
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "context_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const result = await services.mergeSellListIntoAccount(
      {
        sourceOwnerId: ownerId,
        targetAccountId: access.actor.accountId as AccountId,
      },
      context,
    );

    return c.json(result);
  });

  return app;
}
