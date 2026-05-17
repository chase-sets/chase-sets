import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { SettlementApiEnv } from "../../../api";
import type { PayoutReadinessServices } from "./runtime";

function requirePayoutReadinessAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission: "payouts.view" | "payouts.setup" | "payouts.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authentication_required", message: t("settlement.features.payoutReadiness.api.route.authentication.required") } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(JSON.stringify({ error: { code: "authorization_forbidden", message: t("settlement.features.payoutReadiness.api.route.forbidden") } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("settlement.features.payoutReadiness.api.route.request.failed");
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function requestPublicOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const host = forwardedHost ?? request.headers.get("host");
  const protocol = forwardedProto ?? requestUrl.protocol.replace(/:$/, "");

  return host ? `${protocol}://${host}` : requestUrl.origin;
}

function hostedRedirectUrlFromBody(
  body: Record<string, unknown>,
  fieldName: string,
  request: Request,
) {
  const value = body[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(t("settlement.features.payoutReadiness.api.route.payout.setup.redirects.must.use.absolute"));
  }

  if (parsed.origin !== requestPublicOrigin(request)) {
    throw new Error(t("settlement.features.payoutReadiness.api.route.payout.setup.redirects.must.stay.on"));
  }

  return parsed.toString();
}

export function createPayoutReadinessRoutes(
  services: PayoutReadinessServices,
) {
  const app = new Hono<SettlementApiEnv>();

  app.get("/payout-readiness", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getPayoutReadiness(access.actor.accountId));
  });

  app.get("/payout-setup/progress", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getPayoutSetupProgress(access.actor.accountId));
  });

  app.post("/payout-setup/onboarding-session", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("settlement.features.payoutReadiness.api.route.authentication.context.missing") } }, 401);
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    try {
      const returnUrl = hostedRedirectUrlFromBody(body, "returnUrl", c.req.raw);
      const refreshUrl = hostedRedirectUrlFromBody(body, "refreshUrl", c.req.raw);
      const result = await services.createOnboardingSession(
        {
          accountId: access.actor.accountId as never,
          contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : null,
          returnUrl,
          refreshUrl,
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/payout-setup/account-management-session", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("settlement.features.payoutReadiness.api.route.authentication.context.missing.2") } }, 401);
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    try {
      const result = await services.createAccountManagementSession(
        {
          accountId: access.actor.accountId as never,
          returnUrl: hostedRedirectUrlFromBody(body, "returnUrl", c.req.raw),
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/payout-setup/refresh", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: { code: "authentication_required", message: t("settlement.features.payoutReadiness.api.route.authentication.context.missing.3") } }, 401);
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    try {
      const readiness = await services.refreshProviderReadiness(
        {
          accountId: access.actor.accountId as never,
          contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : null,
        },
        context,
      );

      return c.json(readiness);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
