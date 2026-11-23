import { Hono } from "hono";
import { ZodError } from "zod";
import type { MarketplaceApiEnv } from "../../../api";
import { MarketplaceAttemptError } from "../../mutation-recovery/api/attempt";
import { marketplaceReceiptResponse } from "../../mutation-recovery/api/receipt";
import { authorizationRequestSchema } from "../domain/contracts";
import { OfferPaymentAuthorizationError } from "../domain/domain";
import type { createOfferPaymentAuthorization } from "./runtime";

export function createOfferPaymentAuthorizationRoutes(services: ReturnType<typeof createOfferPaymentAuthorization>) {
  const app = new Hono<MarketplaceApiEnv>();
  app.use("*", async (c, next) => {
    const { actor, context } = c.var;
    if (!actor || !context) return c.json({ error: { code: "authentication_required" } }, 401);
    if (
      actor.accountId !== context.audit.forAccountId ||
      actor.userId !== context.audit.performedByUserId ||
      actor.tenantId !== context.tenantId
    )
      return c.json({ error: { code: "not_found" } }, 404);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof MarketplaceAttemptError)
      return c.json({ error: { code: error.code } }, error.code === "invalid_attempt" ? 400 : 409);
    if (error instanceof OfferPaymentAuthorizationError) return c.json({ error: { code: error.code } }, 409);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: { code: "invalid_authority" } }, 400);
    throw error;
  });
  app.get("/", async (c) => c.json(await services.read(c.var.actor!.accountId)));
  app.post("/commands", async (c) => {
    const result = await services.execute(authorizationRequestSchema.parse(await c.req.json()), c.var.context!);
    return marketplaceReceiptResponse(c.json(result), result);
  });
  return app;
}
