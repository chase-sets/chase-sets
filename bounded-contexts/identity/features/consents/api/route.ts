import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { IdentityApiEnv } from "../../../api";
import { hasPermission } from "../../../support/request-support/permissions";
import type { ConsentServices } from "./runtime";

function authenticationRequired() {
  return {
    error: {
      code: "authentication_required",
      message: t("identity.features.consents.api.route.authentication.required"),
    },
  };
}

export function consentRoutes(services: ConsentServices) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(authenticationRequired(), 401);
    }

    const canManageSecurity = hasPermission(actor, "security.manage");
    const { search, status, limit, offset, userId, accountId } = c.req.query();
    const result = await services.listConsents({
      search,
      status,
      userId: canManageSecurity ? userId : actor.userId,
      accountId: canManageSecurity ? accountId : actor.accountId,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  return app;
}
