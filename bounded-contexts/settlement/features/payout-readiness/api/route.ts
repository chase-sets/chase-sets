import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { SettlementApiEnv } from "../../../api";
import type { PayoutReadinessServices } from "./runtime";
import type { AccountId } from "@chase-sets/primitives/typed-ids";

function requirePayoutReadinessAccess(
  c: {
    get(key: "actor"): SettlementApiEnv["Variables"]["actor"];
  },
  permission: "payouts.view" | "payouts.setup",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("settlement.features.payoutReadiness.api.route.authentication.required"),
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("settlement.features.payoutReadiness.api.route.forbidden"),
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("settlement.features.payoutReadiness.api.route.request.failed");
}

export function createPayoutReadinessRoutes(services: PayoutReadinessServices) {
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

  app.post("/payout-setup/embedded-session", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.payoutReadiness.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    try {
      const result = await services.createPayoutSetupSession(
        {
          accountId: access.actor.accountId as AccountId,
          contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : null,
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/payout-setup/account-management-embedded-session", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.setup");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.payoutReadiness.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.createPayoutAccountManagementSession(
        {
          accountId: access.actor.accountId as AccountId,
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
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("settlement.features.payoutReadiness.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    try {
      const readiness = await services.refreshProviderReadiness(
        {
          accountId: access.actor.accountId as AccountId,
          contactEmail: typeof body.contactEmail === "string" ? body.contactEmail : null,
          providerReference: typeof body.providerReference === "string" ? body.providerReference : null,
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
