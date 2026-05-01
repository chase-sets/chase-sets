import { Hono } from "hono";
import type { SettlementApiEnv } from "../../../api";
import type { PayoutReadinessServices } from "./runtime";

function requirePayoutReadinessAccess(
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

function parseMissingRequirements(value: unknown) {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
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
    const access = requirePayoutReadinessAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await services.createOnboardingSession(
        {
          accountId: access.actor.accountId as never,
          returnUrl: typeof body.returnUrl === "string" ? body.returnUrl : null,
          refreshUrl: typeof body.refreshUrl === "string" ? body.refreshUrl : null,
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/payout-setup/refresh", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.manage");
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

  app.post("/payout-readiness/provider-status", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.recordProviderReadiness(
        {
          accountId: access.actor.accountId as never,
          status: String(body.status ?? "not-started"),
          missingRequirements: parseMissingRequirements(body.missingRequirements),
          providerReference:
            body.providerReference === null || body.providerReference === undefined
              ? null
              : String(body.providerReference),
          onboardingStatus:
            typeof body.onboardingStatus === "string"
              ? body.onboardingStatus
              : undefined,
          transferCapabilityStatus:
            typeof body.transferCapabilityStatus === "string"
              ? body.transferCapabilityStatus
              : undefined,
          payoutCapabilityStatus:
            typeof body.payoutCapabilityStatus === "string"
              ? body.payoutCapabilityStatus
              : undefined,
          payoutDestinationStatus:
            typeof body.payoutDestinationStatus === "string"
              ? body.payoutDestinationStatus
              : undefined,
        },
        context,
      );

      return c.json({ account_id: result.accountId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
