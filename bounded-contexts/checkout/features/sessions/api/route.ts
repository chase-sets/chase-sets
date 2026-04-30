import { Hono } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSessionServices } from "./runtime";
import {
  createCheckoutOrdersThroughOrdering,
  createCheckoutPaymentThroughPayments,
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

export function createBuyerCheckoutSessionRoutes(
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
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      if (body.source?.type === "cart" || body.sourceType === "cart") {
        const result = await services.createFromCart(
          {
            buyerAccountId: access.actor.accountId as never,
            shippingOption: String(body.shippingOption ?? "standard"),
          },
          context,
        );
        return c.json({ session_id: result.sessionId }, 201);
      }

      const source = body.source && typeof body.source === "object"
        ? body.source as Record<string, unknown>
        : body as Record<string, unknown>;
      const result = await services.createBuyNow(
        {
          buyerAccountId: access.actor.accountId as never,
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
          shippingOption: String(body.shippingOption ?? "standard"),
        },
        context,
      );
      return c.json({ session_id: result.sessionId }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
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
      return c.json({ error: "Checkout session not found." }, 404);
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
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      await services.selectShippingOption(
        {
          sessionId: c.req.param("sessionId"),
          buyerAccountId: access.actor.accountId as never,
          shippingOption: String(body.shippingOption ?? "standard"),
        },
        context,
      );
      return c.json({ session_id: c.req.param("sessionId") });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/checkout-sessions/:sessionId/confirm", async (c) => {
    const access = requireCheckoutAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const sessionId = c.req.param("sessionId");

    try {
      let session = await services.getSession(sessionId, access.actor.accountId);
      if (!session) {
        return c.json({ error: "Checkout session not found." }, 404);
      }

      if (session.payment_id) {
        return c.json({ payment_id: session.payment_id, order_ids: session.order_ids });
      }

      let orderIds = [...session.order_ids];
      if (orderIds.length === 0) {
        orderIds = await createCheckoutOrdersThroughOrdering(
          c.req.raw,
          session,
        );
        await services.recordOrdersCreated(
          {
            sessionId,
            buyerAccountId: access.actor.accountId as never,
            orderIds,
          },
          context,
        );
      }

      const paymentId = await createCheckoutPaymentThroughPayments(
        c.req.raw,
        sessionId,
        orderIds,
      );
      await services.recordPaymentStarted(
        {
          sessionId,
          buyerAccountId: access.actor.accountId as never,
          paymentId,
        },
        context,
      );

      session = await services.getSession(sessionId, access.actor.accountId);
      return c.json({
        payment_id: paymentId,
        order_ids: orderIds,
        session,
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
