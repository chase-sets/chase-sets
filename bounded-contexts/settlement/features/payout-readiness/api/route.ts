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

function hostedRedirectUrlFromBody(
  body: Record<string, unknown>,
  fieldName: string,
  requestUrl: string,
) {
  const value = body[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Payout setup redirects must use absolute URLs.");
  }

  if (parsed.origin !== new URL(requestUrl).origin) {
    throw new Error("Payout setup redirects must stay on this site.");
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

  app.post("/payout-setup/onboarding-session", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    try {
      const returnUrl = hostedRedirectUrlFromBody(body, "returnUrl", c.req.url);
      const refreshUrl = hostedRedirectUrlFromBody(body, "refreshUrl", c.req.url);
      const result = await services.createOnboardingSession(
        {
          accountId: access.actor.accountId as never,
          returnUrl,
          refreshUrl,
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/payout-setup/account-management-session", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    try {
      const result = await services.createAccountManagementSession(
        {
          accountId: access.actor.accountId as never,
          returnUrl: hostedRedirectUrlFromBody(body, "returnUrl", c.req.url),
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/payout-setup/refresh", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    try {
      const readiness = await services.refreshProviderReadiness(
        {
          accountId: access.actor.accountId as never,
        },
        context,
      );

      return c.json(readiness);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
