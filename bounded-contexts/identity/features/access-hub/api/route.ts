import { t } from "@chase-sets/localization";
import { hasPermission } from "@chase-sets/platform-runtime/auth";
import { Hono } from "hono";
import type { IdentityApiEnv } from "../../../api";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import type { AccessHubServices } from "./runtime";

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: t("identity.features.accounts.api.route.forbidden"),
    },
  };
}

export function accessHubRoutes(services: AccessHubServices) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(forbidden(), 403);
    }

    return c.json(
      await services.getHome({
        search: c.req.query("search"),
        scopeAccountId: actor.roleKey === PLATFORM_ADMIN_ROLE_KEY ? null : actor.accountId,
        includeMemberships: hasPermission(actor, "memberships.view"),
        includeApiKeys: hasPermission(actor, "security.manage"),
      }),
    );
  });

  app.get("/accounts/:accountId", async (c) => {
    const actor = c.var.actor;
    const accountId = c.req.param("accountId");
    if (!actor || (actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY && actor.accountId !== accountId)) {
      return c.json(forbidden(), 403);
    }

    const hub = await services.getAccount(accountId);
    if (!hub) {
      return c.json(
        { error: { code: "not_found", message: t("identity.features.accounts.api.route.account.not.found") } },
        404,
      );
    }
    return c.json(hub);
  });

  app.get("/users/:userId/account", async (c) => {
    const actor = c.var.actor;
    const userId = c.req.param("userId");
    if (!actor || (actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY && actor.userId !== userId)) {
      return c.json(forbidden(), 403);
    }
    return c.json(await services.getUserAccountLink(userId));
  });

  return app;
}
