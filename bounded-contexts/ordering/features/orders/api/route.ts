import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { normalizeShippingOption } from "../domain/common";
import type { OrderingApiEnv } from "../../../api";
import type { OrderingOrderServices } from "./runtime";

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
      response: new Response(JSON.stringify({ error: { code: "authentication_required", message: t("ordering.features.orders.api.route.authentication.required") } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    if (
      options.allowGuestCheckout &&
      actor.permissions.includes("guest-checkout.manage")
    ) {
      return { actor, response: null };
    }

    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authorization_forbidden", message: t("ordering.features.orders.api.route.forbidden") } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("ordering.features.orders.api.route.request.failed");
}

function parseShippingAddress(value: unknown) {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    name:
      source.name === null || source.name === undefined
        ? null
        : String(source.name),
    line1: String(source.line1 ?? ""),
    line2:
      source.line2 === null || source.line2 === undefined
        ? null
        : String(source.line2),
    city: String(source.city ?? ""),
    state: String(source.state ?? ""),
    postalCode: String(source.postalCode ?? ""),
    country: String(source.country ?? "US"),
  };
}

export function createAccountPurchaseOrderRoutes(services: OrderingOrderServices) {
  const app = new Hono<OrderingApiEnv>();

  app.post("/purchases/checkout", async (c) => {
    const access = requireOrderAccess(c, "orders.manage", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("ordering.features.orders.api.route.authentication.context.missing") } }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.createOrdersFromCheckout(
        {
          buyerAccountId: access.actor.accountId as never,
          checkoutSessionId: String(body.checkoutSessionId ?? ""),
          sourceType: body.sourceType === "buy-now" ? "buy-now" : "cart-checkout",
          shippingOption: normalizeShippingOption(String(body.shippingOption ?? "standard")),
          shippingAddress: parseShippingAddress(body.shippingAddress),
          lines: Array.isArray(body.lines)
            ? body.lines.map((line: Record<string, unknown>) => ({
                listingId:
                  line.listingId === null || line.listingId === undefined
                    ? null
                    : String(line.listingId),
                cartLineId:
                  line.cartLineId === null || line.cartLineId === undefined
                    ? null
                    : String(line.cartLineId),
                catalogItemId: String(line.catalogItemId ?? ""),
                productId: String(line.productId ?? ""),
                itemTitle: String(line.itemTitle ?? ""),
                itemSubtitle:
                  line.itemSubtitle === null || line.itemSubtitle === undefined
                    ? null
                    : String(line.itemSubtitle),
                selectedOptions: Array.isArray(line.selectedOptions)
                  ? line.selectedOptions
                  : [],
                productSummary:
                  line.productSummary === null || line.productSummary === undefined
                    ? null
                    : String(line.productSummary),
                quantity: Number(line.quantity ?? 0),
              }))
            : [],
        },
        context,
      );

      return c.json({ orderIds: result.orderIds, status: "created" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/purchases", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listPurchases({
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

  app.get("/purchases/:id", async (c) => {
    const access = requireOrderAccess(c, "orders.view", {
      allowGuestCheckout: true,
    });
    if (access.response) {
      return access.response;
    }

    const order = await services.getPurchase(c.req.param("id"), access.actor.accountId);
    if (!order) {
      return c.json({ error: { code: "not_found", message: t("ordering.features.orders.api.route.purchase.not.found") } }, 404);
    }

    return c.json(order);
  });

  app.post("/purchases/:id/cancel", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("ordering.features.orders.api.route.authentication.context.missing.2") } }, 401);
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
    const result = await services.listSales({
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

  app.get("/sales/:id", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const order = await services.getSale(c.req.param("id"), access.actor.accountId);
    if (!order) {
      return c.json({ error: { code: "not_found", message: t("ordering.features.orders.api.route.sale.not.found") } }, 404);
    }

    return c.json(order);
  });

  app.post("/sales/:id/cancel", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("ordering.features.orders.api.route.authentication.context.missing.3") } }, 401);
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
