import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { SettlementApiEnv } from "../../../api";
import type { PayoutServices } from "./runtime";

function requirePayoutAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission:
    | "payouts.view"
    | "payouts.request"
    | "payouts.reconcile"
    | "payouts.manage",
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

export function createPayoutRoutes(services: PayoutServices) {
  const app = new Hono<SettlementApiEnv>();

  app.get("/payouts", async (c) => {
    const access = requirePayoutAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listPayouts({
      accountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/payouts/reconciliation", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 100);
    const filter = c.req.query("filter") ?? null;
    const items = await services.listPayoutsNeedingReconciliation({ limit, filter });

    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  app.post("/payouts/reconciliation/run", async (c) => {
    const access = requirePayoutAccess(c, "payouts.reconcile");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const limit = Number((body as { limit?: unknown }).limit ?? 100);
    const result = await services.reconcilePayoutsNeedingAttention(
      { limit },
      context,
    );

    return c.json(result);
  });

  app.get("/payouts/:id", async (c) => {
    const access = requirePayoutAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    const payout = await services.getPayout(
      c.req.param("id"),
      access.actor.accountId,
    );
    if (!payout) {
      return c.json({ error: "Payout not found." }, 404);
    }

    return c.json(payout);
  });

  app.post("/payouts", async (c) => {
    const access = requirePayoutAccess(c, "payouts.request");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.requestPayout(
        {
          accountId: access.actor.accountId as never,
          amount: String(body.amount ?? ""),
          destinationReference:
            typeof body.destinationReference === "string"
              ? body.destinationReference
              : null,
          note:
            typeof body.note === "string"
              ? body.note
              : null,
        },
        context,
      );

      return c.json({ id: result.payoutId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}

export function createMoneyMovementWebhookRoutes(services: PayoutServices) {
  const app = new Hono();

  app.post("/money-movement/webhooks", async (c) => {
    try {
      const rawBody = await c.req.raw.text();
      const signatureHeader = c.req.header("Stripe-Signature") ?? null;
      const result = await services.processMoneyMovementWebhook(
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
