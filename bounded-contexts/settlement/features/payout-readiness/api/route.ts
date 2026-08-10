import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { resolveCurrentActorPrimaryEmail } from "./request-support/identity-current-actor";
import type { SettlementApiEnv } from "../../../api";
import { PayoutAccountManagementError, type PayoutReadinessServices } from "./runtime";
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

/**
 * Account-management refusals carry their own machine code, so the wire
 * contract is read from the thrown error rather than re-derived by matching on
 * a human-readable message (which drifts the moment the copy is localized).
 * `step_up_required` keeps its documented 400 status: this endpoint is called
 * by the embedded provider surface, and the openapi contract already declares
 * 401 for "no session at all", which is a different remedy.
 */
function accountManagementErrorBody(error: unknown) {
  if (error instanceof PayoutAccountManagementError && error.code === "step_up_required") {
    return {
      code: "step_up_required",
      message: t("settlement.features.payoutReadiness.api.route.step.up.required"),
    };
  }

  // Provider-authority failures (`missing_provider_account`) and every other
  // failure keep the documented `validation_failed` code: re-authenticating
  // cannot resolve them, so a client must not offer step-up for them.
  return { code: "validation_failed", message: errorMessage(error) };
}

async function resolveActorContactEmail(request: Request) {
  return resolveCurrentActorPrimaryEmail(request);
}

async function contactEmailFromRequest(request: Request, body: Record<string, unknown>) {
  const actorContactEmail = await resolveActorContactEmail(request);
  if (actorContactEmail) {
    return actorContactEmail;
  }

  return typeof body.contactEmail === "string" ? body.contactEmail : null;
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
          contactEmail: await contactEmailFromRequest(c.req.raw, body),
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
          actorUserId: access.actor.userId,
          // Auth's own session-authentication moment. The request body carries
          // no security input for this action -- a client-supplied token is
          // exactly the dead contract this surface replaced.
          authenticatedAt: access.actor.authenticatedAt ?? null,
        },
        context,
      );

      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: accountManagementErrorBody(error) }, 400);
    }
  });

  app.post("/payout-setup/notification-banner-session", async (c) => {
    const access = requirePayoutReadinessAccess(c, "payouts.view");
    if (access.response) {
      return access.response;
    }

    try {
      const result = await services.createPayoutNotificationBannerSession({
        accountId: access.actor.accountId as AccountId,
      });
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
          contactEmail: await contactEmailFromRequest(c.req.raw, body),
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
