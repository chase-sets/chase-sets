import { Hono } from "hono";
import { normalizeShippingOption } from "../../../support/runtime-support/common";
import type { OrderingApiEnv } from "../../../api";
import type { OrderingOrderServices } from "./runtime";

function requireOrderAccess(
  c: {
    get(key: "actor"): OrderingApiEnv["Variables"]["actor"];
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

export function createBuyerOrderRoutes(services: OrderingOrderServices) {
  const app = new Hono<OrderingApiEnv>();

  app.post("/cart/checkout", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.checkoutCart(
        {
          buyerAccountId: access.actor.accountId as never,
          shippingOption: normalizeShippingOption(String(body.shippingOption ?? "standard")),
        },
        context,
      );

      return c.json({ orderIds: result.orderIds }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/orders/buy-now", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.buyNow(
        {
          buyerAccountId: access.actor.accountId as never,
          listingId: String(body.listingId ?? ""),
          productId: String(body.productId ?? ""),
          quantity: Number(body.quantity ?? 0),
          shippingOption: normalizeShippingOption(String(body.shippingOption ?? "standard")),
        },
        context,
      );

      return c.json({ orderIds: result.orderIds }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/orders", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listBuyerOrders({
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

  app.get("/orders/:id", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const order = await services.getBuyerOrder(c.req.param("id"), access.actor.accountId);
    if (!order) {
      return c.json({ error: "Order not found." }, 404);
    }

    return c.json(order);
  });

  app.post("/orders/:id/cancel", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.cancelBuyerOrder(
        {
          orderId: c.req.param("id"),
          buyerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.orderId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}

export function createSellerOrderRoutes(services: OrderingOrderServices) {
  const app = new Hono<OrderingApiEnv>();

  app.get("/orders", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSellerOrders({
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

  app.get("/orders/:id", async (c) => {
    const access = requireOrderAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const order = await services.getSellerOrder(c.req.param("id"), access.actor.accountId);
    if (!order) {
      return c.json({ error: "Order not found." }, 404);
    }

    return c.json(order);
  });

  app.post("/orders/:id/cancel", async (c) => {
    const access = requireOrderAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.cancelSellerOrder(
        {
          orderId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.orderId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
