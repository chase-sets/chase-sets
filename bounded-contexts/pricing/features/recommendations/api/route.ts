import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import type { PricingRecommendationServices } from "./runtime";

function requireRecommendationAccess(
  c: { get(key: "actor"): PricingApiEnv["Variables"]["actor"] },
  permission: "pricing.view" | "pricing.manage",
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

export function createSellerRecommendationRoutes(
  services: PricingRecommendationServices,
) {
  const app = new Hono<PricingApiEnv>();

  app.get("/recommendations", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listSellerRecommendations({
      sellerAccountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/recommendations/:id", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.view");
    if (access.response) {
      return access.response;
    }

    const recommendation = await services.getSellerRecommendation(
      c.req.param("id"),
      access.actor.accountId,
    );
    if (!recommendation) {
      return c.json({ error: "Recommendation not found." }, 404);
    }

    return c.json(recommendation);
  });

  app.post("/recommendations/:id/publish", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json({ error: "Authentication context missing." }, 401);
    }

    const body = await c.req.json();

    try {
      const result = await services.publishRecommendation(
        {
          recommendationId: c.req.param("id"),
          sellerAccountId: access.actor.accountId,
          recommendedListAmount: Number(body.recommendedListAmount),
          reason: String(body.reason ?? ""),
          publishedAt:
            typeof body.publishedAt === "string"
              ? body.publishedAt
              : undefined,
        },
        context,
      );
      return c.json({ id: result.recommendationId, version: result.version });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}
