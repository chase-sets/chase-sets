import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PaymentsApiEnv } from "../../payments/api/route";
import type { RefundServices } from "./runtime";

function requireRefundAccess(
  c: {
    get(key: "actor"): PaymentsApiEnv["Variables"]["actor"];
  },
  permission: "orders.manage",
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

export function createRefundRoutes(services: RefundServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.post("/payments/:paymentId/refunds", async (c) => {
    const access = requireRefundAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();
    try {
      const result = await services.issueRefund(
        {
          paymentId: c.req.param("paymentId") as never,
          orderIds: Array.isArray(body.orderIds)
            ? body.orderIds.map(String)
            : [],
          amount: String(body.amount ?? ""),
          reason: String(body.reason ?? "Operator refund"),
        },
        context as EventStoreContext,
      );

      return c.json({ id: result.refundId, version: result.version }, 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Refund failed." },
        400,
      );
    }
  });

  return app;
}
