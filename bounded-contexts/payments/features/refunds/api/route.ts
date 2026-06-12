import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PaymentsApiEnv } from "../../payments/api/route";
import type { RefundServices } from "./runtime";
import type { PaymentId } from "@chase-sets/primitives/typed-ids";

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
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("payments.features.refunds.api.route.authentication.required"),
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
          error: { code: "authorization_forbidden", message: t("payments.features.refunds.api.route.forbidden") },
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

export function createRefundRoutes(services: RefundServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.post("/payments/:paymentId/refunds", async (c) => {
    const access = requireRefundAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("payments.features.refunds.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();
    try {
      const result = await services.issueRefund(
        {
          paymentId: c.req.param("paymentId") as PaymentId,
          orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [],
          amount: String(body.amount ?? ""),
          reason: String(body.reason ?? t("payments.features.refunds.api.route.operator.refund")),
        },
        context as EventStoreContext,
      );

      return c.json({ id: result.refundId, version: result.version, status: "requested" }, 201);
    } catch (error) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: error instanceof Error ? error.message : t("payments.features.refunds.api.route.refund.failed"),
          },
        },
        400,
      );
    }
  });

  return app;
}
