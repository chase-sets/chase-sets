import { Hono } from "hono";
import type { OrderingApiEnv } from "../api";
import type { OrderingCartServices } from "./runtime";

function requireCartAccess(
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

function parseVersionSelection(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter(
          (selection): selection is { dimensionId: string; choiceId: string } =>
            Boolean(
              selection &&
              typeof selection === "object" &&
              "dimensionId" in selection &&
              "choiceId" in selection,
            ),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          choiceId: String(selection.choiceId ?? ""),
        }))
    : [];
}

export function createBuyerCartRoutes(services: OrderingCartServices) {
  const app = new Hono<OrderingApiEnv>();

  app.get("/cart", async (c) => {
    const access = requireCartAccess(c, "orders.view");
    if (access.response) {
      return access.response;
    }

    const items = await services.listCartLines(access.actor.accountId);
    return c.json({
      items,
      count: items.length,
    });
  });

  app.post("/cart", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.addLine(
        {
          buyerAccountId: access.actor.accountId as never,
          catalogItemId: String(body.catalogItemId ?? ""),
          itemTitle: String(body.itemTitle ?? ""),
          itemSubtitle:
            body.itemSubtitle === null || body.itemSubtitle === undefined
              ? null
              : String(body.itemSubtitle),
          versionSelection: parseVersionSelection(body.versionSelection),
          versionSummary:
            body.versionSummary === null || body.versionSummary === undefined
              ? null
              : String(body.versionSummary),
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.setLineQuantity(
        {
          buyerAccountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const result = await services.removeLine(
        {
          buyerAccountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
