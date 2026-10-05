import { Hono } from "hono";
import { ZodError } from "zod";
import type { MarketplaceApiEnv } from "../../../api";
import { buyerOfferPolicyRequestSchema } from "../domain/contracts";
import { BuyerOfferPolicyError } from "../domain/domain";
import type { BuyerOfferPolicyServices } from "./runtime";

export function createBuyerOfferPolicyRoutes(services: BuyerOfferPolicyServices) {
  const app = new Hono<MarketplaceApiEnv>();
  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    const context = c.get("context");
    if (!actor || !context) return c.json({ error: { code: "authentication_required" } }, 401);
    if (context.audit.forAccountId !== actor.accountId || context.audit.performedByUserId !== actor.userId) {
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    }
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof BuyerOfferPolicyError) {
      return c.json(
        { error: { code: error.code } },
        error.code === "not_found" ? 404 : error.code === "enforcement_unavailable" ? 503 : 409,
      );
    }
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: { code: "invalid_authority" } }, 400);
    throw error;
  });
  app.get("/", async (c) =>
    c.json(
      await services.list(c.get("actor")!.accountId, c.req.query("after") ?? "", Number(c.req.query("limit") ?? 100)),
    ),
  );
  app.get("/:id", async (c) => c.json(await services.get(c.req.param("id"), c.get("actor")!.accountId)));
  app.post("/:id/commands", async (c) => {
    const request = buyerOfferPolicyRequestSchema.parse(await c.req.json());
    return c.json(await services.execute(c.req.param("id"), request, c.get("context")!));
  });
  return app;
}
