import { Hono } from "hono";
import type { SettlementApiEnv } from "../api";
import type { PayoutServices } from "./runtime";

function requirePayoutAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission: "payouts.view" | "payouts.manage",
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
    const access = requirePayoutAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.schedulePayout(
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

  app.post("/payouts/:id/send", async (c) => {
    const access = requirePayoutAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.markPayoutInTransit(
        {
          payoutId: c.req.param("id"),
          accountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.payoutId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/payouts/:id/complete", async (c) => {
    const access = requirePayoutAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.completePayout(
        {
          payoutId: c.req.param("id"),
          accountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.payoutId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/payouts/:id/fail", async (c) => {
    const access = requirePayoutAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await services.failPayout(
        {
          payoutId: c.req.param("id"),
          accountId: access.actor.accountId,
          failureReason:
            typeof body.failureReason === "string"
              ? body.failureReason
              : null,
        },
        context,
      );
      return c.json({ id: result.payoutId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
