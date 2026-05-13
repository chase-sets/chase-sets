import { Hono, type Context } from "hono";
import type { DiscoveryApiEnv } from "../../../api";
import type { ProductAlertServices } from "./runtime";

function requireProductAlertAccess(c: {
  get(key: "actor"): DiscoveryApiEnv["Variables"]["actor"];
}) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({
        error: {
          code: "authentication_required",
          message: "Sign in to manage Product Alerts.",
        },
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes("accounts.view")) {
    return {
      actor: null,
      response: new Response(JSON.stringify({
        error: {
          code: "authorization_forbidden",
          message: "This account cannot manage Product Alerts.",
        },
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function parseSelectedOptions(value: unknown) {
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Product Alert request failed.";
}

export function createProductAlertRoutes(services: ProductAlertServices) {
  const app = new Hono<DiscoveryApiEnv>();

  app.get("/product-alerts", async (c) => {
    const access = requireProductAlertAccess(c);
    if (access.response) return access.response;

    const items = await services.listProductAlerts({
      accountId: access.actor.accountId,
    });

    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  app.post("/product-alerts", async (c) => {
    const access = requireProductAlertAccess(c);
    if (access.response) return access.response;

    const context = c.get("context");
    if (!context) {
      return c.json({
        error: {
          code: "authentication_required",
          message: "Authentication context is missing.",
        },
      }, 401);
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await services.createProductAlert({
        accountId: access.actor.accountId,
        marketSide: body.marketSide === "offer" ? "offer" : "listing",
        catalogItemId: String(body.catalogItemId ?? ""),
        productId: String(body.productId ?? ""),
        selectedOptions: parseSelectedOptions(body.selectedOptions),
        productSummary:
          body.productSummary === null || body.productSummary === undefined
            ? null
            : String(body.productSummary),
        thresholdAmount:
          body.thresholdAmount === null || body.thresholdAmount === undefined
            ? null
            : String(body.thresholdAmount),
      }, context);

      return c.json({ id: result.alertId, version: result.version, status: "active" }, 201);
    } catch (error) {
      return c.json({
        error: { code: "validation_failed", message: errorMessage(error) },
      }, 400);
    }
  });

  app.post("/product-alerts/:id/pause", async (c) => {
    return updateAlert(c, services, "pause");
  });

  app.post("/product-alerts/:id/resume", async (c) => {
    return updateAlert(c, services, "resume");
  });

  app.post("/product-alerts/:id/delete", async (c) => {
    return updateAlert(c, services, "delete");
  });

  return app;
}

async function updateAlert(
  c: Context<DiscoveryApiEnv>,
  services: ProductAlertServices,
  action: "pause" | "resume" | "delete",
) {
  const access = requireProductAlertAccess(c);
  if (access.response) return access.response;

  const context = c.get("context");
  if (!context) {
    return c.json({
      error: {
        code: "authentication_required",
        message: "Authentication context is missing.",
      },
    }, 401);
  }

  try {
    const input = {
      accountId: access.actor.accountId,
      alertId: String(c.req.param("id") ?? ""),
    };
    const result =
      action === "pause"
        ? await services.pauseProductAlert(input, context)
        : action === "resume"
          ? await services.resumeProductAlert(input, context)
          : await services.deleteProductAlert(input, context);

    return c.json({ id: result.alertId, version: result.version, status: action });
  } catch (error) {
    return c.json({
      error: { code: "validation_failed", message: errorMessage(error) },
    }, 400);
  }
}
