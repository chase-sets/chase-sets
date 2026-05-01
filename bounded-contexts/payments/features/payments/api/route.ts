import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PaymentServices } from "./runtime";
import { normalizeRequestedBalanceCreditAmount } from "./balance-credit-request";

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
      response: new Response(JSON.stringify({ error: { code: "authentication_required", message: "Authentication required." } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authorization_forbidden", message: "Forbidden." } }), {
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

function resolvePublicOrigin(requestUrl: string, headers: Headers) {
  const parsed = new URL(requestUrl);
  const host =
    headers.get("x-forwarded-host") ??
    headers.get("host") ??
    parsed.host;
  const protocol =
    headers.get("x-forwarded-proto") ??
    parsed.protocol.replace(":", "") ??
    "https";

  return `${protocol}://${host}`;
}

export function createAccountPaymentRoutes(services: PaymentServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.post("/payments", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
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
      const payment = await services.createAccountPayment(
        {
          accountId: access.actor.accountId as never,
          orderIds: Array.isArray(body.orderIds)
            ? body.orderIds.map(String)
            : [],
          currencyCode: String(body.currencyCode ?? "usd"),
          requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(
            body.requestedBalanceCreditAmount,
          ),
          returnUrlBase: resolvePublicOrigin(c.req.url, c.req.raw.headers),
          clientRiskContext: {
            ipAddress:
              c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
              c.req.header("x-real-ip") ??
              null,
            userAgent: c.req.header("user-agent") ?? null,
          },
          ...(sourceContext && sourceReferenceId
            ? { sourceContext, sourceReferenceId }
            : {}),
        },
        context,
      );

      return c.json(payment, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout/status", async (c) => {
    const access = requirePaymentAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    try {
      const orderIds =
        c.req.queries("orderId") ??
        c.req.query("orderIds")?.split(",").map((value) => value.trim()) ??
        [];
      const status = await services.getCheckoutStatus({
        accountId: access.actor.accountId as never,
        orderIds: orderIds.filter(Boolean) as never,
        currencyCode: c.req.query("currencyCode") ?? "usd",
        requestedBalanceCreditAmount:
          c.req.query("requestedBalanceCreditAmount") ?? null,
      });

      return c.json(status);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/checkout/recover", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    const body = await c.req.json();
    try {
      const payment = await services.recoverCheckoutPayment(
        {
          accountId: access.actor.accountId as never,
          orderIds: Array.isArray(body.orderIds)
            ? body.orderIds.map(String)
            : [],
          currencyCode: String(body.currencyCode ?? "usd"),
          requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(
            body.requestedBalanceCreditAmount,
          ),
          returnUrlBase: resolvePublicOrigin(c.req.url, c.req.raw.headers),
          clientRiskContext: {
            ipAddress:
              c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
              c.req.header("x-real-ip") ??
              null,
            userAgent: c.req.header("user-agent") ?? null,
          },
        },
        context,
      );

      return c.json(payment, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/checkout/recovery", async (c) => {
    const access = requirePaymentAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    try {
      const orderIds =
        c.req.queries("orderId") ??
        c.req.query("orderIds")?.split(",").map((value) => value.trim()) ??
        [];
      const recovery = await services.getCheckoutRecoveryOptions({
        accountId: access.actor.accountId as never,
        orderIds: orderIds.filter(Boolean) as never,
        currencyCode: c.req.query("currencyCode") ?? "usd",
        requestedBalanceCreditAmount:
          c.req.query("requestedBalanceCreditAmount") ?? null,
      });

      return c.json(recovery);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/payments/:id", async (c) => {
    const access = requirePaymentAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const payment = await services.getAccountPayment(
      c.req.param("id"),
      access.actor.accountId,
    );
    if (!payment) {
      return c.json({ error: { code: "not_found", message: "Payment not found." } }, 404);
    }

    return c.json(payment);
  });

  app.get("/payments/:id/timeline", async (c) => {
    const access = requirePaymentAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const timeline = await services.getPaymentMoneyTimeline({
      paymentId: c.req.param("id"),
      accountId: access.actor.accountId,
    });
    if (!timeline) {
      return c.json({ error: { code: "not_found", message: "Payment not found." } }, 404);
    }

    return c.json(timeline);
  });

  app.get("/provider-events/:providerEventId", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const event = await services.getProviderEvent({
      providerEventId: c.req.param("providerEventId"),
      accountId: access.actor.accountId,
    });
    if (!event) {
      return c.json({ error: { code: "not_found", message: "Provider event not found." } }, 404);
    }

    return c.json(event);
  });

  app.get("/provider-idempotency", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    return c.json({
      items: await services.listProviderIdempotencyKeys({
        accountId: access.actor.accountId,
        limit: Number(c.req.query("limit") ?? 25),
      }),
    });
  });

  app.get("/reconciliation/runs", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const items = await services.listReconciliationRuns({
      limit: Number(c.req.query("limit") ?? 25),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/provider-health", async (c) => {
    const access = requirePaymentAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getProviderHealth());
  });

  return app;
}

export function createPaymentProcessorWebhookRoutes(
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
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
