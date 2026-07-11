import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AuthenticityServices } from "./support/runtime-support/services";
import { authenticityCaseRoutes } from "./features/cases/api/route";

export type AuthenticityActor = Readonly<{
  accountId: string;
  permissions: readonly string[];
}>;

export type AuthenticityApiEnv = {
  Variables: {
    actor: AuthenticityActor;
    context: EventStoreContext;
  };
};

function requiredPermissionForMethod(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "authenticity.view";
    default:
      return "authenticity.manage";
  }
}

export function buildAuthenticityApi(services: AuthenticityServices) {
  const app = new Hono<AuthenticityApiEnv>();

  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json(
        { error: { code: "authentication_required", message: t("authenticity.api.authentication.required") } },
        401,
      );
    }

    const requiredPermission = requiredPermissionForMethod(c.req.method);
    if (!actor.permissions.includes(requiredPermission)) {
      return c.json({ error: { code: "authorization_forbidden", message: t("authenticity.api.forbidden") } }, 403);
    }

    await next();
  });

  app.route("/cases", authenticityCaseRoutes(services.cases));

  return app;
}
