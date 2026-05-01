import { Hono } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutCartServices } from "./runtime";

function requireCartAccess(
  c: {
    get(key: "actor"): CheckoutApiEnv["Variables"]["actor"];
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

function parseVersionSelection(value: unknown) {
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

export function createAccountCartRoutes(services: CheckoutCartServices) {
  const app = new Hono<CheckoutApiEnv>();

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
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.addLine(
        {
          accountId: access.actor.accountId as never,
          catalogItemId: String(body.catalogItemId ?? ""),
          productId: String(body.productId ?? ""),
          itemTitle: String(body.itemTitle ?? ""),
          itemSubtitle:
            body.itemSubtitle === null || body.itemSubtitle === undefined
              ? null
              : String(body.itemSubtitle),
          selectedOptions: parseVersionSelection(body.selectedOptions),
          productSummary:
            body.productSummary === null || body.productSummary === undefined
              ? null
              : String(body.productSummary),
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "added" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/quantity", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.setLineQuantity(
        {
          accountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
          quantity: Number(body.quantity ?? 0),
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "quantity-updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/cart/:lineId/remove", async (c) => {
    const access = requireCartAccess(c, "orders.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: "Authentication context missing." } }, 401);
    }

    try {
      const result = await services.removeLine(
        {
          accountId: access.actor.accountId as never,
          lineId: c.req.param("lineId") as never,
        },
        context,
      );

      return c.json({ id: result.lineId, version: result.version, status: "removed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
