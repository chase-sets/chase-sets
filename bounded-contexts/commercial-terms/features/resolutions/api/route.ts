import { Hono } from "hono";
import type { CommercialTermsApiEnv } from "../../../api";
import type { ResolutionServices } from "./runtime";

function requireAccess(
  c: { get(key: "actor"): CommercialTermsApiEnv["Variables"]["actor"] },
  permission: "commercial-terms.view" | "commercial-terms.manage",
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

export function createResolutionRoutes(services: ResolutionServices) {
  const app = new Hono<CommercialTermsApiEnv>();

  app.post("/preview", async (c) => {
    const access = requireAccess(c, "commercial-terms.view");
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json();

    try {
      const scope = body.scope === "order" ? "order" : "listing";
      const result =
        scope === "order"
          ? await services.previewOrderTerms({
              sellerAccountId: String(body.sellerAccountId ?? access.actor.accountId),
              amount: String(body.amount ?? ""),
              effectiveAt:
                typeof body.effectiveAt === "string" ? body.effectiveAt : undefined,
            })
          : await services.previewListingTerms({
              sellerAccountId: String(body.sellerAccountId ?? access.actor.accountId),
              amount: String(body.amount ?? ""),
              effectiveAt:
                typeof body.effectiveAt === "string" ? body.effectiveAt : undefined,
            });

      return c.json(result);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
