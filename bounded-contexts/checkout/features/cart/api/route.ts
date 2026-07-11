import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { CheckoutApiEnv } from "../../../api";
import {
  anonymousRequestRateLimitedResponse,
  createAnonymousRailCaptureRateLimiter,
  createCheckoutAccessGuard,
  createGuestCheckoutContext,
} from "../../../support/request-support/checkout-route-guard";
import type { CartLineId } from "../../../support/runtime-support/common";
import type { CheckoutObservabilityTelemetry } from "../../sessions/api/checkout-observability-telemetry";
import { recordCartReadinessObservability } from "./cart-readiness-observability";
import { parseCartReadinessDecisionInput } from "../domain/readiness";
import type { CheckoutCartServices } from "./runtime";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";

const MAX_ANONYMOUS_CART_LINES = 50;
const requireCartAccess = createCheckoutAccessGuard({
  authenticationRequiredMessage: t("checkout.features.cart.api.route.authentication.required"),
  authorizationForbiddenMessage: t("checkout.features.cart.api.route.forbidden"),
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.cart.api.route.request.failed");
}

function optionalBodyString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const createGuestCartContext = () =>
  createGuestCheckoutContext({
    performedByUserId: "usr_guest_checkout" as UserId,
    forAccountId: "acc_guest_checkout" as AccountId,
  });

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

function parseFulfillmentMode(body: Record<string, unknown>) {
  const lockedListingId =
    body.lockedListingId === null || body.lockedListingId === undefined
      ? null
      : String(body.lockedListingId).trim() || null;
  return {
    fulfillmentMode:
      body.fulfillmentMode === "locked-listing" || lockedListingId
        ? ("locked-listing" as const)
        : ("optimize" as const),
    lockedListingId,
    sellerPreferenceId:
      body.sellerPreferenceId === null || body.sellerPreferenceId === undefined
        ? null
        : String(body.sellerPreferenceId).trim() || null,
  };
}

function parseSelectedListingSnapshot(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const listingId = source.listingId === null || source.listingId === undefined ? "" : String(source.listingId).trim();
  if (!listingId) {
    return null;
  }

  return {
    listingId,
    sellerAccountId: optionalBodyString(source.sellerAccountId),
    sellerDisplayName: optionalBodyString(source.sellerDisplayName),
    sellerSlug: optionalBodyString(source.sellerSlug),
    priceAmount: optionalBodyString(source.priceAmount),
    source: optionalBodyString(source.source),
  };
}

function parseCartLineBody(body: Record<string, unknown>) {
  const fulfillment = parseFulfillmentMode(body);

  return {
    catalogItemId: String(body.catalogItemId ?? ""),
    productId: String(body.productId ?? ""),
    itemTitle: String(body.itemTitle ?? ""),
    itemSubtitle: body.itemSubtitle === null || body.itemSubtitle === undefined ? null : String(body.itemSubtitle),
    itemImageUrl: body.itemImageUrl === null || body.itemImageUrl === undefined ? null : String(body.itemImageUrl),
    itemImageSrcSet: optionalBodyString(body.itemImageSrcSet),
    itemImageLoadingUrl: optionalBodyString(body.itemImageLoadingUrl),
    itemImageLoadingAlt: optionalBodyString(body.itemImageLoadingAlt),
    itemImageLoadingSrcSet: optionalBodyString(body.itemImageLoadingSrcSet),
    selectedOptions: parseVersionSelection(body.selectedOptions),
    productSummary:
      body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
    quantity: Number(body.quantity ?? 0),
    ...fulfillment,
    selectedListingSnapshot: parseSelectedListingSnapshot(body.selectedListingSnapshot),
  };
}

function countCartItems(items: readonly { quantity: number }[]) {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

type CartLineBody = ReturnType<typeof parseCartLineBody>;

function cartLineKey(line: {
  catalog_catalog_item_id?: string;
  catalogItemId?: string;
  product_id?: string;
  productId?: string;
  fulfillment_mode?: "optimize" | "locked-listing";
  fulfillmentMode?: "optimize" | "locked-listing";
  locked_listing_id?: string | null;
  lockedListingId?: string | null;
  seller_preference_id?: string | null;
  sellerPreferenceId?: string | null;
}) {
  return [
    line.catalog_catalog_item_id ?? line.catalogItemId ?? "",
    line.product_id ?? line.productId ?? "",
    line.fulfillment_mode ?? line.fulfillmentMode ?? "optimize",
    line.locked_listing_id ?? line.lockedListingId ?? "",
    line.seller_preference_id ?? line.sellerPreferenceId ?? "",
  ].join("|");
}

function isExistingCartLine(
  line: Awaited<ReturnType<CheckoutCartServices["listCartLines"]>>[number],
  body: CartLineBody,
) {
  return cartLineKey(line) === cartLineKey(body);
}

function newCartLineCount(
  existingLines: Awaited<ReturnType<CheckoutCartServices["listCartLines"]>>,
  requestedLines: readonly CartLineBody[],
) {
  const existingKeys = new Set(existingLines.map(cartLineKey));
  const newKeys = new Set<string>();

  for (const line of requestedLines) {
    const key = cartLineKey(line);
    if (!existingKeys.has(key)) {
      newKeys.add(key);
    }
  }

  return newKeys.size;
}

function anonymousCartLimitExceededResponse() {
  return {
    error: {
      code: "anonymous_cart_limit_exceeded",
      message: t("checkout.features.cart.api.route.anonymous.cart.limit.exceeded", {
        limit: MAX_ANONYMOUS_CART_LINES,
      }),
    },
  };
}

export function createAccountCartRoutes(
  services: CheckoutCartServices,
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/cart", async (c) => {
    const access = requireCartAccess(c, { allowGuestCheckout: true });
    if (access.response) {
      return access.response;
    }

    const items = await services.listCartLines(access.actor.accountId);
    return c.json({
      items,
      count: countCartItems(items),
    });
  });

  app.post("/cart/readiness", async (c) => {
    const access = requireCartAccess(c, { allowGuestCheckout: true });
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json().catch(() => ({}));
    const snapshot = await services.createReadinessSnapshot({
      accountId: access.actor.accountId,
      decisions: parseCartReadinessDecisionInput(body),
    });
    recordCartReadinessObservability(checkoutObservabilityTelemetry, snapshot, {
      actor: access.actor,
      fallbackActorMode: "signed-in",
    });

    return c.json({ readiness: snapshot });
  });

  app.post("/cart", async (c) => {
    const access = requireCartAccess(c);
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

    const body = await c.req.json();

    try {
      const result = await services.addLine(
        {
          accountId: access.actor.accountId as AccountId,
          ...parseCartLineBody(body),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "added" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/bulk", async (c) => {
    const access = requireCartAccess(c);
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
    const rawLines: unknown[] = Array.isArray(body.lines) ? body.lines : [];

    try {
      const result = await services.addLines(
        {
          accountId: access.actor.accountId as AccountId,
          lines: rawLines
            .filter((line: unknown): line is Record<string, unknown> => Boolean(line && typeof line === "object"))
            .map(parseCartLineBody),
        },
        context,
      );

      return c.json({ status: "completed", ...result });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const access = requireCartAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.setLineQuantity(
        {
          accountId: access.actor.accountId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "cli", "lineId"),
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "quantity-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/fulfillment", async (c) => {
    const access = requireCartAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("checkout.features.cart.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    const fulfillment = parseFulfillmentMode(body);
    const selectedListingSnapshot =
      body && typeof body === "object"
        ? parseSelectedListingSnapshot((body as Record<string, unknown>).selectedListingSnapshot)
        : null;

    try {
      const result = await services.setLineFulfillment(
        {
          accountId: access.actor.accountId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "cli", "lineId"),
          availabilityState:
            body.availabilityState === "unavailable" ||
            body.availabilityState === "changed" ||
            body.availabilityState === "waiting-for-supply"
              ? body.availabilityState
              : "available",
          ...fulfillment,
          selectedListingSnapshot,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "fulfillment-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const access = requireCartAccess(c);
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
          accountId: access.actor.accountId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "cli", "lineId"),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

function requireAnonymousCartId(c: { req: { header: (name: string) => string | undefined } }) {
  const ownerId = c.req.header("x-checkout-anonymous-cart-id")?.trim() ?? "";
  if (!ownerId.startsWith("anon_")) {
    return null;
  }

  return ownerId;
}

export function createGuestCartRoutes(
  services: CheckoutCartServices,
  checkoutObservabilityTelemetry?: CheckoutObservabilityTelemetry,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<CheckoutApiEnv>();
  const anonymousCartCaptureRateLimiter = createAnonymousRailCaptureRateLimiter(
    "checkout:anonymous-cart-capture",
    resolveRateLimitRule,
  );

  app.get("/cart", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json({ items: [], count: 0 });
    }

    const items = await services.listCartLines(ownerId);
    return c.json({ items, count: countCartItems(items) });
  });

  app.post("/cart/readiness", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const snapshot = await services.createReadinessSnapshot({
      accountId: ownerId,
      decisions: parseCartReadinessDecisionInput(body),
    });
    recordCartReadinessObservability(checkoutObservabilityTelemetry, snapshot, {
      actor: null,
      fallbackActorMode: "guest",
    });

    return c.json({ readiness: snapshot });
  });

  app.post("/cart", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const rateLimit = await anonymousCartCaptureRateLimiter.check(c.req.raw);
    if (rateLimit.limited) {
      const response = anonymousRequestRateLimitedResponse(
        t("checkout.features.cart.api.route.anonymous.request.rate.limited"),
        rateLimit.retryAfterSeconds,
      );
      return c.json(response.body, 429, response.headers);
    }

    const context = c.get("context") ?? createGuestCartContext();

    const body = await c.req.json();
    const line = parseCartLineBody(body);

    try {
      const existingLines = await services.listCartLines(ownerId);
      if (
        existingLines.length >= MAX_ANONYMOUS_CART_LINES &&
        !existingLines.some((existingLine) => isExistingCartLine(existingLine, line))
      ) {
        return c.json(anonymousCartLimitExceededResponse(), 400);
      }

      const result = await services.addLine(
        {
          accountId: ownerId as AccountId,
          ...line,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "added" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/bulk", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const rateLimit = await anonymousCartCaptureRateLimiter.check(c.req.raw);
    if (rateLimit.limited) {
      const response = anonymousRequestRateLimitedResponse(
        t("checkout.features.cart.api.route.anonymous.request.rate.limited"),
        rateLimit.retryAfterSeconds,
      );
      return c.json(response.body, 429, response.headers);
    }

    const context = c.get("context") ?? createGuestCartContext();
    const body = await c.req.json<Record<string, unknown>>();
    const rawLines: unknown[] = Array.isArray(body.lines) ? body.lines : [];
    const lines = rawLines
      .filter((line: unknown): line is Record<string, unknown> => Boolean(line && typeof line === "object"))
      .map(parseCartLineBody);

    try {
      const existingLines = await services.listCartLines(ownerId);
      if (existingLines.length + newCartLineCount(existingLines, lines) > MAX_ANONYMOUS_CART_LINES) {
        return c.json(anonymousCartLimitExceededResponse(), 400);
      }

      const result = await services.addLines(
        {
          accountId: ownerId as AccountId,
          lines,
        },
        context,
      );

      return c.json({ status: "completed", ...result });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestCartContext();
    const body = await c.req.json();

    try {
      const result = await services.setLineQuantity(
        {
          accountId: ownerId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "cli", "lineId"),
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "quantity-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/fulfillment", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestCartContext();
    const body = await c.req.json();
    const fulfillment = parseFulfillmentMode(body);
    const selectedListingSnapshot =
      body && typeof body === "object"
        ? parseSelectedListingSnapshot((body as Record<string, unknown>).selectedListingSnapshot)
        : null;

    try {
      const result = await services.setLineFulfillment(
        {
          accountId: ownerId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "cli", "lineId"),
          availabilityState:
            body.availabilityState === "unavailable" ||
            body.availabilityState === "changed" ||
            body.availabilityState === "waiting-for-supply"
              ? body.availabilityState
              : "available",
          ...fulfillment,
          selectedListingSnapshot,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "fulfillment-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const ownerId = requireAnonymousCartId(c);
    if (!ownerId) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context") ?? createGuestCartContext();

    try {
      const result = await services.removeLine(
        {
          accountId: ownerId as AccountId,
          lineId: parseTypedIdBoundary(c.req.param("lineId"), "cli", "lineId"),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/merge-to-account", async (c) => {
    const access = requireCartAccess(c, { allowGuestCheckout: true });
    if (access.response) {
      return access.response;
    }

    const ownerId = requireAnonymousCartId(c);
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

    const result = await services.mergeCartIntoAccount(
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
