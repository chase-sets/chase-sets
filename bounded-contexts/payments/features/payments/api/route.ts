import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PaymentServices } from "./runtime";

export type PaymentsApiEnv = AuthenticatedApiEnv;

function requirePaymentAccess(
  c: {
    get(key: "actor"): PaymentsApiEnv["Variables"]["actor"];
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

export function createBuyerPaymentRoutes(services: PaymentServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.post("/payments", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();
    const sourceContext =
      body.sourceContext === null || body.sourceContext === undefined
        ? null
        : String(body.sourceContext);
    const sourceReferenceId =
      body.sourceReferenceId === null || body.sourceReferenceId === undefined
        ? null
        : String(body.sourceReferenceId);

    try {
      const payment = await services.createBuyerPayment(
        {
          buyerAccountId: access.actor.accountId as never,
          orderIds: Array.isArray(body.orderIds)
            ? body.orderIds.map(String)
            : [],
          currencyCode: String(body.currencyCode ?? "usd"),
          ...(sourceContext && sourceReferenceId
            ? { sourceContext, sourceReferenceId }
            : {}),
        },
        context,
      );

      return c.json(payment, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/payments/:id", async (c) => {
    const access = requirePaymentAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const payment = await services.getBuyerPayment(
      c.req.param("id"),
      access.actor.accountId,
    );
    if (!payment) {
      return c.json({ error: "Payment not found." }, 404);
    }

    return c.json(payment);
  });

  return app;
}

export function createStripeWebhookRoutes(
  services: PaymentServices,
) {
  const app = new Hono();

  app.post("/webhooks", async (c) => {
    try {
      const rawBody = await c.req.raw.text();
      const signatureHeader = c.req.header("Stripe-Signature") ?? null;
      const result = await services.processWebhook(
        {
          rawBody,
          signatureHeader,
        },
        {
          tenantId: "tnt_identity" as never,
          audit: {
            performedByUserId: "usr_identity_system" as never,
            forAccountId: "acc_identity_system" as never,
          },
        } as EventStoreContext,
      );

      return c.json(result, 200);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
