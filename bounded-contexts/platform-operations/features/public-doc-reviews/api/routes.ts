import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { PlatformOperationsApiEnv } from "../../../api";
import type { PublicDocReviewServices } from "./runtime";

function requireAccess(
  c: { get(key: "actor"): PlatformOperationsApiEnv["Variables"]["actor"] },
  permission: "platform-policy.view" | "platform-policy.manage",
) {
  const actor = c.get("actor");
  if (!actor) return { actor: null, response: new Response(null, { status: 401 }) };
  if (!actor.permissions.includes(permission)) return { actor: null, response: new Response(null, { status: 403 }) };
  return { actor, response: null };
}

export function createPublicDocReviewRoutes(services: PublicDocReviewServices) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.get("/", async (c) => {
    const access = requireAccess(c, "platform-policy.view");
    if (access.response) return access.response;
    return c.json({ items: await services.listPending() });
  });

  app.post("/:locale/:articleSlug/:policyKey/confirm", async (c) => {
    const access = requireAccess(c, "platform-policy.manage");
    if (access.response) return access.response;
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("platformOperations.policyConsole.reviewQueue.contextMissing"),
          },
        },
        401,
      );
    }
    const confirmed = await services.confirm(
      {
        locale: c.req.param("locale"),
        articleSlug: c.req.param("articleSlug"),
        policyKey: c.req.param("policyKey"),
        operatorUserId: access.actor.userId,
      },
      context,
    );
    return confirmed ? c.json({ confirmed: true }) : c.json({ error: { code: "not_found" } }, 404);
  });

  return app;
}
