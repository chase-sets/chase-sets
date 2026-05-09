import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSessionServices } from "./runtime";
import {
  createCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments,
  normalizeRequestedBalanceCreditAmount,
} from "../../../support/request-support/checkout-confirmation";

function requireCheckoutAccess(
  c: {
    get(key: "actor"): CheckoutApiEnv["Variables"]["actor"];
  },
  permission: "orders.view" | "orders.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authentication_required", message: t("checkout.features.sessions.api.route.authentication.required") } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    if (actor.permissions.includes("guest-checkout.manage")) {
      return { actor, response: null };
    }

    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authorization_forbidden", message: t("checkout.features.sessions.api.route.forbidden") } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("checkout.features.sessions.api.route.request.failed");
}

function parseSelectedOptions(value: unknown) {
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

function parseShippingAddress(value: unknown) {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    name:
      source.name === null || source.name === undefined
        ? ""
        : String(source.name),
    company:
      source.company === null || source.company === undefined
        ? null
        : String(source.company),
    line1: String(source.line1 ?? ""),
    line2:
      source.line2 === null || source.line2 === undefined
        ? null
        : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
    phone:
      source.phone === null || source.phone === undefined
        ? null
        : String(source.phone),
    email:
      source.email === null || source.email === undefined
        ? null
        : String(source.email),
  };
}

function parseOptimizationGoal(value: unknown) {
  return value === "fewest-shipments" ? "fewest-shipments" as const : "lowest-total" as const;
}

export function createAccountCheckoutSessionRoutes(
  services: CheckoutSessionServices,
) {
  const app = new Hono<CheckoutApiEnv>();

  app.post("/checkout-sessions", async (c) => {
    const access = requireCheckoutAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

      const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.sessions.api.route.authentication.context.missing") } }, 401);
    }

    const body = await c.req.json();

    try {
      if (body.source?.type === "cart" || body.sourceType === "cart") {
        const result = await services.createFromCart(
          {
            accountId: access.actor.accountId as never,
            shippingOption: String(body.shippingOption ?? "standard"),
            optimizationGoal: parseOptimizationGoal(body.optimizationGoal),
          },
          context,
        );
        return c.json({ session_id: result.sessionId, status: "started" }, 201);
      }

      const source = body.source && typeof body.source === "object"
        ? body.source as Record<string, unknown>
        : body as Record<string, unknown>;
      const result = await services.createBuyNow(
        {
          accountId: access.actor.accountId as never,
          listingId: String(source.listingId ?? ""),
          catalogItemId: String(source.catalogItemId ?? ""),
          productId: String(source.productId ?? ""),
          itemTitle: String(source.itemTitle ?? ""),
          itemSubtitle:
            source.itemSubtitle === null || source.itemSubtitle === undefined
              ? null
              : String(source.itemSubtitle),
          selectedOptions: parseSelectedOptions(source.selectedOptions),
          productSummary:
            source.productSummary === null || source.productSummary === undefined
              ? null
              : String(source.productSummary),
          quantity: Number(source.quantity ?? 0),
          fulfillmentMode:
            source.fulfillmentMode === "locked-listing" || String(source.lockedListingId ?? source.listingId ?? "").trim()
              ? "locked-listing"
              : "optimize",
          lockedListingId:
            source.lockedListingId === null || source.lockedListingId === undefined
              ? String(source.listingId ?? "") || null
              : String(source.lockedListingId || "") || null,
          sellerPreferenceId:
            source.sellerPreferenceId === null || source.sellerPreferenceId === undefined
              ? null
              : String(source.sellerPreferenceId || "") || null,
          optimizationGoal: parseOptimizationGoal(body.optimizationGoal),
          shippingOption: String(body.shippingOption ?? "standard"),
        },
        context,
      );
      return c.json({ session_id: result.sessionId, status: "started" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout-sessions/:sessionId", async (c) => {
    const access = requireCheckoutAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const session = await services.getSession(
      c.req.param("sessionId"),
      access.actor.accountId,
    );
    if (!session) {
      return c.json({ error: { code: "not_found", message: t("checkout.features.sessions.api.route.checkout.session.not.found") } }, 404);
    }

    return c.json(session);
  });

  app.post("/checkout-sessions/:sessionId/shipping-option", async (c) => {
    const access = requireCheckoutAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.sessions.api.route.authentication.context.missing.2") } }, 401);
    }

    const body = await c.req.json();

    try {
      await services.selectShippingOption(
        {
          sessionId: c.req.param("sessionId"),
          accountId: access.actor.accountId as never,
          shippingOption: String(body.shippingOption ?? "standard"),
        },
        context,
      );
      return c.json({
        session_id: c.req.param("sessionId"),
        status: "shipping-option-selected",
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/checkout-sessions/:sessionId/optimization-goal", async (c) => {
    const access = requireCheckoutAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.sessions.api.route.authentication.context.missing.2") } }, 401);
    }

    const body = await c.req.json();

    try {
      await services.selectOptimizationGoal(
        {
          sessionId: c.req.param("sessionId"),
          accountId: access.actor.accountId as never,
          optimizationGoal: parseOptimizationGoal(body.optimizationGoal),
        },
        context,
      );
      return c.json({
        session_id: c.req.param("sessionId"),
        status: "optimization-goal-selected",
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/checkout-sessions/:sessionId/confirm", async (c) => {
    const access = requireCheckoutAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("checkout.features.sessions.api.route.authentication.context.missing.3") } }, 401);
    }

      const sessionId = c.req.param("sessionId");
      const body = await c.req.json().catch(() => ({}));
      const requestedBalanceCreditAmount = normalizeRequestedBalanceCreditAmount(
        body.requestedBalanceCreditAmount,
      );
      const paymentMethodCategory = String(body.paymentMethodCategory ?? "card");
      const marketplaceCheckoutFeeQuoteFingerprint =
        typeof body.marketplaceCheckoutFeeQuoteFingerprint === "string"
          ? body.marketplaceCheckoutFeeQuoteFingerprint
          : null;
      const fulfillmentPreviewRevision =
        typeof body.fulfillmentPreviewRevision === "string"
          ? body.fulfillmentPreviewRevision
          : null;
      const acknowledgedMaterialChanges = body.acknowledgedMaterialChanges === true;

    try {
      let session = await services.getSession(sessionId, access.actor.accountId);
      if (!session) {
        return c.json({ error: { code: "not_found", message: t("checkout.features.sessions.api.route.checkout.session.not.found.2") } }, 404);
      }

      if (session.payment_id) {
        return c.json({
          payment_id: session.payment_id,
          order_ids: session.order_ids,
          status: "confirmed",
        });
      }

      if (
        session.fulfillment_preview_revision &&
        fulfillmentPreviewRevision !== session.fulfillment_preview_revision &&
        !acknowledgedMaterialChanges
      ) {
        return c.json(
          {
            error: {
              code: "fulfillment_preview_stale",
              message: t("checkout.features.sessions.api.route.fulfillment.preview.stale"),
            },
          },
          409,
        );
      }

      await services.setShippingAddress(
        {
          sessionId,
          accountId: access.actor.accountId as never,
          shippingAddress: parseShippingAddress(body.shippingAddress),
        },
        context,
      );
      session = await services.getSession(sessionId, access.actor.accountId);
      if (!session) {
        return c.json({ error: { code: "not_found", message: t("checkout.features.sessions.api.route.checkout.session.not.found.2") } }, 404);
      }

      let orderIds = [...session.order_ids];
      if (orderIds.length === 0) {
        const checkoutOrders = await createCheckoutOrdersThroughOrdering(
          c.req.raw,
          session,
          {
            fulfillmentPreviewRevision,
            acknowledgedMaterialChanges,
          },
        );
        orderIds = checkoutOrders.orderIds;
        await services.recordOrdersCreated(
          {
            sessionId,
            accountId: access.actor.accountId as never,
            orderIds,
            fulfilledLineKeys: checkoutOrders.readyLineKeys,
          },
          context,
        );
      }

      const paymentId = await createCheckoutPaymentThroughPayments(
        c.req.raw,
        sessionId,
        orderIds,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
        marketplaceCheckoutFeeQuoteFingerprint,
        access.actor.roleKey === "guest-buyer"
          ? "/checkout/payments/:paymentId"
          : "/account/payments/:paymentId",
      );
      await services.recordPaymentStarted(
        {
          sessionId,
          accountId: access.actor.accountId as never,
          paymentId,
        },
        context,
      );

      session = await services.getSession(sessionId, access.actor.accountId);
      return c.json({
        payment_id: paymentId,
        order_ids: orderIds,
        status: "confirmed",
        session,
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
