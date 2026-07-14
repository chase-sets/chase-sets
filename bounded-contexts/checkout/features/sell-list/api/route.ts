import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { SellListLineId } from "../../../support/runtime-support/common";
import type { CheckoutApiEnv } from "../../../api";
import {
  anonymousRequestRateLimitedResponse,
  createAnonymousRailCaptureRateLimiter,
  createCheckoutAccessGuard,
  createGuestCheckoutContext,
} from "../../../support/request-support/checkout-route-guard";
import type { SellListConfirmationSummary, SellListSellerConfirmationEvidence } from "../domain/domain";
import { parseSellListReadinessDecisionInput } from "../domain/readiness";
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

function parseLineOutcomeStatus(value: unknown): "completed" | "partial" | "skipped" {
  return value === "completed" || value === "partial" || value === "skipped" ? value : "skipped";
}

function parseLineOutcomeAction(
  value: unknown,
): "accepted-offer" | "accepted-smart-match" | "published-listing" | "mixed" | "kept-in-sell-list" {
  return value === "accepted-offer" ||
    value === "accepted-smart-match" ||
    value === "published-listing" ||
    value === "mixed" ||
    value === "kept-in-sell-list"
    ? value
    : "kept-in-sell-list";
}

function parseLineOutcomeReferences(value: unknown) {
  const source = objectValue(value);
  if (!source) {
    return undefined;
  }

  const offerIds = Array.isArray(source.offerIds)
    ? source.offerIds
        .map(String)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;
  const listingId = source.listingId === null || source.listingId === undefined ? null : stringValue(source.listingId);
  return {
    ...(offerIds && offerIds.length > 0 ? { offerIds } : {}),
    ...(listingId ? { listingId } : listingId === null ? { listingId: null } : {}),
  };
}

function parseSideEffectStatus(value: unknown): SellListConfirmationSummary["sideEffects"]["sale"] | null {
  return value === "not-attempted" ||
    value === "not-applicable" ||
    value === "handoff-recorded" ||
    value === "pending-downstream" ||
    value === "failed"
    ? value
    : null;
}

function parseSideEffects(value: unknown): SellListConfirmationSummary["sideEffects"] | null {
  const source = objectValue(value);
  if (!source) {
    return null;
  }

  const sale = parseSideEffectStatus(source.sale);
  const label = parseSideEffectStatus(source.label);
  const payout = parseSideEffectStatus(source.payout);
  const settlement = parseSideEffectStatus(source.settlement);
  const notification = parseSideEffectStatus(source.notification);
  const accountHistory = parseSideEffectStatus(source.accountHistory);
  if (!sale || !label || !payout || !settlement || !notification || !accountHistory) {
    return null;
  }

  return { sale, label, payout, settlement, notification, accountHistory };
}

function parseSellerEvidence(value: unknown): SellListSellerConfirmationEvidence | null {
  const source = objectValue(value);
  const shipFrom = objectValue(source?.shipFrom);
  const payout = objectValue(source?.payout);
  const label = objectValue(source?.label);
  const risk = objectValue(source?.risk);
  const provider = objectValue(source?.provider);
  const freshness = objectValue(source?.freshness);
  if (!shipFrom || !payout || !label || !risk || !provider || !freshness) {
    return null;
  }
  if (
    shipFrom.status !== "ready" ||
    payout.status !== "ready" ||
    payout.method !== "saved-payout" ||
    label.status !== "ready" ||
    (label.preference !== "prepaid-label" && label.preference !== "seller-label-later") ||
    risk.status !== "clear" ||
    provider.status !== "ready" ||
    freshness.status !== "current"
  ) {
    return null;
  }
  const shipFromCountry = stringValue(shipFrom.country);
  const shipFromRegion = stringValue(shipFrom.region);
  const shipFromPostalCode = stringValue(shipFrom.postalCode);
  const payoutReadinessStatus = stringValue(payout.readinessStatus);
  if (!shipFromCountry || !shipFromRegion || !shipFromPostalCode || payoutReadinessStatus !== "ready") {
    return null;
  }

  return {
    shipFrom: {
      status: "ready",
      addressId:
        shipFrom.addressId === null || shipFrom.addressId === undefined ? null : stringValue(shipFrom.addressId),
      country: shipFromCountry,
      region: shipFromRegion,
      postalCode: shipFromPostalCode,
    },
    payout: {
      status: "ready",
      method: "saved-payout",
      readinessStatus: payoutReadinessStatus,
      lastCheckedAt:
        payout.lastCheckedAt === null || payout.lastCheckedAt === undefined ? null : stringValue(payout.lastCheckedAt),
    },
    label: {
      status: "ready",
      preference: label.preference,
    },
    risk: { status: "clear" },
    provider: { status: "ready" },
    freshness: { status: "current" },
  };
}

function parseHandoffSummary(value: unknown): SellListConfirmationSummary | null {
  const source = objectValue(value);
  if (!source) {
    return null;
  }

  const sideEffects = parseSideEffects(source.sideEffects);
  if (!sideEffects) {
    return null;
  }

  const lineOutcomes = Array.isArray(source.lineOutcomes)
    ? source.lineOutcomes
        .map(objectValue)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({
          lineId: stringValue(entry.lineId) as SellListLineId,
          itemTitle: stringValue(entry.itemTitle),
          status: parseLineOutcomeStatus(entry.status),
          action: parseLineOutcomeAction(entry.action),
          quantity: Number(entry.quantity ?? 0),
          remainingQuantity: Number(entry.remainingQuantity ?? 0),
          detail: stringValue(entry.detail),
          references: parseLineOutcomeReferences(entry.references),
        }))
        .filter((entry) => entry.lineId && entry.itemTitle)
    : [];

  return {
    acceptedOfferCount: Number(source.acceptedOfferCount ?? 0),
    publishedListingCount: Number(source.publishedListingCount ?? 0),
    skippedLineCount: Number(source.skippedLineCount ?? 0),
    skippedReasons: Array.isArray(source.skippedReasons) ? source.skippedReasons.map(String).filter(Boolean) : [],
    lineOutcomes,
    sideEffects,
  };
}

function parseSellListConfirmationBody(body: Record<string, unknown>) {
  const confirmationId = String(body.confirmationId ?? body.confirmation_id ?? "").trim();
  const readinessSnapshotId = String(body.readinessSnapshotId ?? body.readiness_snapshot_id ?? "").trim();
  const readinessSourceRevision = String(body.readinessSourceRevision ?? body.readiness_source_revision ?? "").trim();
  const readinessDecisions = parseSellListReadinessDecisionInput(body.readinessDecisions ?? body.readiness_decisions);
  const completedLineIds = Array.isArray(body.completedLineIds)
    ? body.completedLineIds.map(String).filter(Boolean)
    : [];
  const remainingLineQuantities = Array.isArray(body.remainingLineQuantities)
    ? body.remainingLineQuantities
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
        .map((entry) => ({
          lineId: String(entry.lineId ?? ""),
          quantity: Number(entry.quantity ?? 0),
        }))
        .filter((entry) => entry.lineId && Number.isFinite(entry.quantity) && entry.quantity > 0)
    : [];
  const sellerEvidence = parseSellerEvidence(body.sellerEvidence ?? body.seller_evidence);
  const handoffSummary = parseHandoffSummary(body.handoffSummary ?? body.handoff_summary);

  return {
    confirmationId,
    readinessSnapshotId,
    readinessSourceRevision,
    readinessDecisions,
    completedLineIds,
    remainingLineQuantities,
    sellerEvidence,
    handoffSummary,
  };
}

function hasSellListConfirmationEvidence(body: ReturnType<typeof parseSellListConfirmationBody>) {
  return Boolean(
    body.confirmationId &&
    body.readinessSnapshotId &&
    body.readinessSourceRevision &&
    body.sellerEvidence &&
    body.handoffSummary,
  );
}

export function createAccountSellListRoutes(
  services: CheckoutSellListServices,
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
) {
  const app = new Hono<CheckoutApiEnv>();

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
    const snapshot = await services.createReadinessSnapshot({
      sellerAccountId: access.actor.accountId,
      decisions: parseSellListReadinessDecisionInput(body),
      sellerEvidence: parseSellerEvidence((body as Record<string, unknown>).sellerEvidence),
    });

    return c.json({ readiness: snapshot });
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
          ...parseSellListLineBody(body),
        },
        context,
      );

      return c.json(
        {
          id: result.lineId,
          version: result.version,
          status: result.status,
          ...(result.commandReceipt ? { commandReceipt: result.commandReceipt } : {}),
        },
        201,
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
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
      const result = await services.removeLine(
        {
          sellerAccountId: access.actor.accountId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "sll", "lineId"),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
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
      const sellerEvidence = confirmationBody.sellerEvidence!;
      const handoffSummary = confirmationBody.handoffSummary!;

      const existingConfirmation = await services.getConfirmation(
        access.actor.accountId,
        confirmationBody.confirmationId,
      );
      if (existingConfirmation) {
        return c.json({
          id: access.actor.accountId,
          confirmationId: confirmationBody.confirmationId,
          version: 0,
          status: "confirmed",
          completedLineIds: [],
          confirmation: existingConfirmation,
        });
      }

      const result = await services.confirmSellListCheckout(
        {
          sellerAccountId: access.actor.accountId as AccountId,
          confirmationId: confirmationBody.confirmationId,
          readinessSnapshotId: confirmationBody.readinessSnapshotId,
          readinessSourceRevision: confirmationBody.readinessSourceRevision,
          readinessDecisions: confirmationBody.readinessDecisions,
          completedLineIds: confirmationBody.completedLineIds as readonly SellListLineId[],
          remainingLineQuantities: confirmationBody.remainingLineQuantities as readonly {
            lineId: SellListLineId;
            quantity: number;
          }[],
          sellerEvidence,
          handoffSummary,
        },
        context,
      );

      return c.json({
        id: result.sellerAccountId,
        confirmationId: confirmationBody.confirmationId,
        version: result.version,
        status: result.status,
        completedLineIds: result.completedLineIds,
        confirmation: result.confirmation,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

export function createGuestSellListRoutes(
  services: CheckoutSellListServices,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<CheckoutApiEnv>();
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
      sellerEvidence: parseSellerEvidence((body as Record<string, unknown>).sellerEvidence),
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
      const existingLines = await services.listLines(ownerId);
      if (
        existingLines.length >= MAX_ANONYMOUS_SELL_LIST_LINES &&
        !existingLines.some((existingLine) => isExistingSellListLine(existingLine, line))
      ) {
        return c.json(
          {
            error: {
              code: "anonymous_sell_list_limit_exceeded",
              message: t("checkout.features.sellList.api.route.anonymous.sell.list.limit.exceeded", {
                limit: MAX_ANONYMOUS_SELL_LIST_LINES,
              }),
            },
          },
          400,
        );
      }

      const result = await services.addLine(
        {
          sellerAccountId: ownerId as AccountId,
          ...line,
        },
        context,
      );

      return c.json(
        {
          id: result.lineId,
          version: result.version,
          status: result.status,
          ...(result.commandReceipt ? { commandReceipt: result.commandReceipt } : {}),
        },
        201,
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
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
      const result = await services.removeLine(
        {
          sellerAccountId: ownerId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "sll", "lineId"),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
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
