import { t } from "@chase-sets/localization";
import { createPolicyBackedRateLimiter, type RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { Hono, type Context } from "hono";
import type { DiscoveryApiEnv } from "../../../api";
import type { ProductAlertServices } from "./runtime";

const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX = 30;
const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_SURFACE = "discovery.product-alert.anonymous-capture";

function requireProductAlertAccess(c: { get(key: "actor"): DiscoveryApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("discovery.features.productAlerts.api.route.sign.in.to.manage.product.alerts"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes("accounts.view")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("discovery.features.productAlerts.api.route.account.cannot.manage.product.alerts"),
          },
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

function parseSelectedOptions(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((selection): selection is { dimensionId: string; optionId: string } =>
          Boolean(selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : t("discovery.features.productAlerts.api.route.product.alert.request.failed");
}

function requireAnonymousProductAlertOwnerId(c: Context<DiscoveryApiEnv>) {
  const value = c.req.header("x-discovery-anonymous-product-alert-id")?.trim() ?? "";
  return value.startsWith("anon_") ? value : null;
}

function anonymousRequestRateLimitedResponse(retryAfterSeconds: number) {
  return {
    body: {
      error: {
        code: "anonymous_request_rate_limited",
        message: t("discovery.features.productAlerts.api.route.anonymous.request.rate.limited"),
      },
    },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
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
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("discovery.features.productAlerts.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await services.createProductAlert(
        {
          accountId: access.actor.accountId,
          marketSide: body.marketSide === "offer" ? "offer" : "listing",
          catalogItemId: String(body.catalogItemId ?? ""),
          productId: String(body.productId ?? ""),
          selectedOptions: parseSelectedOptions(body.selectedOptions),
          productSummary:
            body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
          thresholdAmount:
            body.thresholdAmount === null || body.thresholdAmount === undefined ? null : String(body.thresholdAmount),
        },
        context,
      );

      return c.json({ id: result.alertId, version: result.version, status: "active" }, 201);
    } catch (error) {
      return c.json(
        {
          error: { code: "validation_failed", message: errorMessage(error) },
        },
        400,
      );
    }
  });

  app.post("/product-alert-intents/:id/claim", async (c) => {
    const access = requireProductAlertAccess(c);
    if (access.response) return access.response;

    const anonymousOwnerId = requireAnonymousProductAlertOwnerId(c);
    if (!anonymousOwnerId) {
      return c.json(
        {
          error: {
            code: "anonymous_product_alert_required",
            message: t("discovery.features.productAlerts.api.route.anonymous.product.alert.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("discovery.features.productAlerts.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    try {
      return c.json(
        await services.claimAnonymousProductAlertIntent(
          {
            anonymousOwnerId,
            intentId: c.req.param("id"),
            accountId: access.actor.accountId,
          },
          context,
        ),
      );
    } catch (error) {
      return c.json(
        {
          error: { code: "validation_failed", message: errorMessage(error) },
        },
        400,
      );
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

export function createGuestProductAlertRoutes(
  services: ProductAlertServices,
  resolveRateLimitRule?: RateLimitRuleResolver,
) {
  const app = new Hono<DiscoveryApiEnv>();
  const anonymousProductAlertCaptureRateLimiter = createPolicyBackedRateLimiter(
    ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_SURFACE,
    { max: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX, windowMs: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS },
    resolveRateLimitRule ?? (async (_surface, defaults) => defaults),
    { keyPrefix: "discovery:anonymous-product-alert-capture" },
  );

  app.post("/product-alert-intents", async (c) => {
    const anonymousOwnerId = requireAnonymousProductAlertOwnerId(c);
    if (!anonymousOwnerId) {
      return c.json(
        {
          error: {
            code: "anonymous_product_alert_required",
            message: t("discovery.features.productAlerts.api.route.anonymous.product.alert.required"),
          },
        },
        400,
      );
    }

    const rateLimit = await anonymousProductAlertCaptureRateLimiter.check(c.req.raw);
    if (rateLimit.limited) {
      const response = anonymousRequestRateLimitedResponse(rateLimit.retryAfterSeconds);
      return c.json(response.body, 429, response.headers);
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      return c.json(
        await services.createAnonymousProductAlertIntent({
          anonymousOwnerId,
          sourcePath: String(body.sourcePath ?? ""),
          marketSide: body.marketSide === "offer" ? "offer" : "listing",
          catalogItemId: String(body.catalogItemId ?? ""),
          productId: String(body.productId ?? ""),
          selectedOptions: parseSelectedOptions(body.selectedOptions),
          productSummary:
            body.productSummary === null || body.productSummary === undefined ? null : String(body.productSummary),
          thresholdAmount:
            body.thresholdAmount === null || body.thresholdAmount === undefined ? null : String(body.thresholdAmount),
        }),
        201,
      );
    } catch (error) {
      return c.json(
        {
          error: { code: "validation_failed", message: errorMessage(error) },
        },
        400,
      );
    }
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
    return c.json(
      {
        error: {
          code: "authentication_required",
          message: t("discovery.features.productAlerts.api.route.authentication.context.missing"),
        },
      },
      401,
    );
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
    return c.json(
      {
        error: { code: "validation_failed", message: errorMessage(error) },
      },
      400,
    );
  }
}
