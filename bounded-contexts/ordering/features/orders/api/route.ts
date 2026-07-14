import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseCheckoutOrderingSourceType } from "@chase-sets/checkout-order-source";
import { normalizeShippingOption } from "../domain/common";
import type { OrderingApiEnv } from "../../../api";
import type { OrderingOrderServices } from "./runtime";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

function requireOrderAccess(
  c: {
    get(key: "actor"): OrderingApiEnv["Variables"]["actor"];
  },
  permission: "orders.view" | "orders.manage",
  options: Readonly<{ allowGuestCheckout?: boolean }> = {},
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("ordering.features.orders.api.route.authentication.required"),
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
    if (options.allowGuestCheckout && actor.permissions.includes("guest-checkout.manage")) {
      return { actor, response: null };
    }

    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authorization_forbidden", message: t("ordering.features.orders.api.route.forbidden") },
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

function requireCheckoutAccess(c: { get(key: "actor"): OrderingApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("ordering.features.orders.api.route.authentication.required"),
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
  return error instanceof Error ? error.message : t("ordering.features.orders.api.route.request.failed");
}

function errorCode(error: unknown) {
  return errorMessage(error).startsWith("Sign in is required") ? "account_sign_in_required" : "validation_failed";
}

/**
 * Mirrors payments' `fee_quote_stale` 409 handling (m109): the
 * authenticity-check fee quote the buyer saw at checkout opt-in time must
 * match Ordering's authoritative recomputation at order-creation time. A
 * mismatch (order value or policy changed between opt-in and submission)
 * is rejected with a fresh quote rather than silently charging a different
 * amount than what the buyer confirmed.
 */
function staleAuthenticityFeeQuoteResponse(c: { json: (body: unknown, status?: number) => Response }, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (!message.startsWith("authenticity_fee_quote_stale:")) {
    return null;
  }
  const quote = JSON.parse(message.slice("authenticity_fee_quote_stale:".length));
  return c.json(
    {
      error: {
        code: "authenticity_fee_quote_stale",
        message: t("ordering.features.orders.api.route.authenticity.fee.quote.stale"),
      },
      authenticity_check_offer: quote,
    },
    409,
  );
}

function canViewReviewOpportunity(actor: OrderingApiEnv["Variables"]["actor"]) {
  return Boolean(actor?.permissions.includes("reputation.view") && actor.permissions.includes("reputation.manage"));
}

function parseShippingAddress(value: unknown) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    name: source.name === null || source.name === undefined ? "" : String(source.name),
    company: source.company === null || source.company === undefined ? null : String(source.company),
    line1: String(source.line1 ?? ""),
    line2: source.line2 === null || source.line2 === undefined ? null : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
    phone: source.phone === null || source.phone === undefined ? null : String(source.phone),
    email: source.email === null || source.email === undefined ? null : String(source.email),
  };
}

function parseAuthenticityCheckOptIn(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.selected !== true) {
    return null;
  }
  const quoteFingerprint = String(record.quoteFingerprint ?? "").trim();
  if (!quoteFingerprint) {
    return null;
  }
  return { selected: true as const, quoteFingerprint };
}

function parseCheckoutReservations(value: unknown) {
  return Array.isArray(value)
    ? value.map((reservation: Record<string, unknown>) => ({
        holdId: String(reservation.holdId ?? ""),
        sellerAccountId: String(reservation.sellerAccountId ?? ""),
        inventoryItemId: String(reservation.inventoryItemId ?? ""),
        quantity: Number(reservation.quantity ?? 0),
      }))
    : [];
}

export function createAccountPurchaseOrderRoutes(services: OrderingOrderServices) {
  const app = new Hono<OrderingApiEnv>();

  app.post("/purchases/checkout/preview", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json();

    try {
      const result = await services.previewCheckoutFulfillment({
        buyerAccountId: access.actor.accountId as AccountId,
        checkoutSessionId: String(body.checkoutSessionId ?? ""),
        sourceType: parseCheckoutOrderingSourceType(body.sourceType),
        shippingOption: normalizeShippingOption(String(body.shippingOption ?? "standard")),
        shippingAddress:
          body.shippingAddress && typeof body.shippingAddress === "object"
            ? parseShippingAddress(body.shippingAddress)
            : null,
        optimizationGoal: body.optimizationGoal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
        authenticityCheckOptIn: Boolean(parseAuthenticityCheckOptIn(body.authenticityCheckOptIn)?.selected),
        lines: Array.isArray(body.lines)
          ? body.lines.map((line: Record<string, unknown>) => ({
              listingId: line.listingId === null || line.listingId === undefined ? null : String(line.listingId),
              cartLineId: line.cartLineId === null || line.cartLineId === undefined ? null : String(line.cartLineId),
              catalogItemId: String(line.catalogItemId ?? ""),
              productId: String(line.productId ?? ""),
              itemTitle: String(line.itemTitle ?? ""),
              itemSubtitle:
                line.itemSubtitle === null || line.itemSubtitle === undefined ? null : String(line.itemSubtitle),
              selectedOptions: Array.isArray(line.selectedOptions) ? line.selectedOptions : [],
              productSummary:
                line.productSummary === null || line.productSummary === undefined ? null : String(line.productSummary),
              quantity: Number(line.quantity ?? 0),
              fulfillmentMode: line.fulfillmentMode === "locked-listing" ? "locked-listing" : "optimize",
              lockedListingId:
                line.lockedListingId === null || line.lockedListingId === undefined
                  ? null
                  : String(line.lockedListingId),
              sellerPreferenceId:
                line.sellerPreferenceId === null || line.sellerPreferenceId === undefined
                  ? null
                  : String(line.sellerPreferenceId),
            }))
          : [],
      });

      return c.json(result);
    } catch (error) {
      return c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400);
    }
  });

  app.post("/purchases/checkout", async (c) => {
    const access = requireCheckoutAccess(c);
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.orders.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.createOrdersFromCheckout(
        {
          buyerAccountId: access.actor.accountId as AccountId,
          checkoutSessionId: String(body.checkoutSessionId ?? ""),
          sourceType: parseCheckoutOrderingSourceType(body.sourceType),
          shippingOption: normalizeShippingOption(String(body.shippingOption ?? "standard")),
          shippingAddress: parseShippingAddress(body.shippingAddress),
          optimizationGoal: body.optimizationGoal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
          fulfillmentPreviewRevision:
            typeof body.fulfillmentPreviewRevision === "string" ? body.fulfillmentPreviewRevision : null,
          acknowledgedMaterialChanges: body.acknowledgedMaterialChanges === true,
          checkoutReservations: parseCheckoutReservations(body.checkoutReservations),
          customerAccountIsGuest:
            !access.actor.permissions.includes("orders.manage") &&
            access.actor.permissions.includes("guest-checkout.manage"),
          authenticityCheckOptIn: parseAuthenticityCheckOptIn(body.authenticityCheckOptIn),
          lines: Array.isArray(body.lines)
            ? body.lines.map((line: Record<string, unknown>) => ({
                listingId: line.listingId === null || line.listingId === undefined ? null : String(line.listingId),
                cartLineId: line.cartLineId === null || line.cartLineId === undefined ? null : String(line.cartLineId),
                catalogItemId: String(line.catalogItemId ?? ""),
                productId: String(line.productId ?? ""),
                itemTitle: String(line.itemTitle ?? ""),
                itemSubtitle:
                  line.itemSubtitle === null || line.itemSubtitle === undefined ? null : String(line.itemSubtitle),
                selectedOptions: Array.isArray(line.selectedOptions) ? line.selectedOptions : [],
                productSummary:
                  line.productSummary === null || line.productSummary === undefined
                    ? null
                    : String(line.productSummary),
                quantity: Number(line.quantity ?? 0),
                fulfillmentMode: line.fulfillmentMode === "locked-listing" ? "locked-listing" : "optimize",
                lockedListingId:
                  line.lockedListingId === null || line.lockedListingId === undefined
                    ? null
                    : String(line.lockedListingId),
                sellerPreferenceId:
                  line.sellerPreferenceId === null || line.sellerPreferenceId === undefined
                    ? null
                    : String(line.sellerPreferenceId),
              }))
            : [],
        },
        context,
      );

      return c.json({ ...result, status: "created" }, 201);
    } catch (error) {
      return (
        staleAuthenticityFeeQuoteResponse(c, error) ??
        c.json({ error: { code: errorCode(error), message: errorMessage(error) } }, 400)
      );
    }
  });

  app.get("/purchases", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const [result, summary] = await Promise.all([
      services.listPurchases({
        buyerAccountId: access.actor.accountId,
        limit,
        offset,
      }),
      services.getPurchaseListSummary(access.actor.accountId),
    ]);

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
      limit,
      offset,
      summary,
    });
  });

  app.get("/purchases/:id", async (c) => {
    const access = requireOrderAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const order = await services.getPurchase(c.req.param("id"), access.actor.accountId);
    if (!order) {
      return c.json(
        { error: { code: "not_found", message: t("ordering.features.orders.api.route.purchase.not.found") } },
        404,
      );
    }

    const reviewOpportunity = canViewReviewOpportunity(access.actor)
      ? await services.getOrderReviewOpportunity(order.order_id, access.actor.accountId)
      : null;

    return c.json({ ...order, reviewOpportunity });
  });

  app.post("/purchases/:id/cancel", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.orders.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.cancelPurchase(
        {
          orderId: c.req.param("id"),
          buyerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.orderId, version: result.version, status: "cancelled" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

export function createAccountSaleOrderRoutes(services: OrderingOrderServices) {
  const app = new Hono<OrderingApiEnv>();

  app.get("/sales", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const [result, summary] = await Promise.all([
      services.listSales({
        sellerAccountId: access.actor.accountId,
        limit,
        offset,
      }),
      services.getSaleListSummary(access.actor.accountId),
    ]);

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
      limit,
      offset,
      summary,
    });
  });

  // Read-only Open Order count for the authenticated seller (m127): the
  // authoritative "N" in the "N of M" Order Capacity display, counted from
  // the Ordering claim ledger so marketplace's seller settings surface never
  // counts orders client-side. Declared before `/sales/:id` so the literal
  // path wins over the id param.
  app.get("/sales/order-capacity", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const openOrderCount = await services.getSellerOpenOrderCount(access.actor.accountId);

    return c.json({ open_order_count: openOrderCount });
  });

  app.get("/sales/:id", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const order = await services.getSale(c.req.param("id"), access.actor.accountId);
    if (!order) {
      return c.json(
        { error: { code: "not_found", message: t("ordering.features.orders.api.route.sale.not.found") } },
        404,
      );
    }

    const reviewOpportunity = canViewReviewOpportunity(access.actor)
      ? await services.getOrderReviewOpportunity(order.order_id, access.actor.accountId)
      : null;

    return c.json({ ...order, reviewOpportunity });
  });

  app.post("/sales/:id/cancel", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("ordering.features.orders.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.cancelSale(
        {
          orderId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.orderId, version: result.version, status: "cancelled" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
