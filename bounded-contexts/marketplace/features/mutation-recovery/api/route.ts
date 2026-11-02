import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import { marketplaceMutationKindSchema, recoveryHashSchema } from "../domain/contracts";
import type { createMarketplaceMutationLookup } from "./lookup";
import { marketplaceReceiptResponse } from "./receipt";

export function createMarketplaceMutationRecoveryRoutes(lookup: ReturnType<typeof createMarketplaceMutationLookup>) {
  const app = new Hono<MarketplaceApiEnv>();
  app.get("/mutation-attempts/:attemptId", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    const kind = marketplaceMutationKindSchema.safeParse(c.req.query("kind"));
    const hash = recoveryHashSchema.safeParse(c.req.query("requestHash"));
    const target = c.req.query("target") ?? "";
    if (!kind.success || !hash.success || !target || target.length > 1024)
      return c.json({ error: { code: "invalid_attempt" } }, 400);
    try {
      const result = await lookup({
        attemptId: c.req.param("attemptId"),
        accountId: actor.accountId,
        mutationKind: kind.data,
        requestHash: hash.data,
        target: {
          kind:
            kind.data === "offer.submit" ? "product" : kind.data === "offer-policy.command" ? "offer-policy" : "offer",
          id: target,
        },
      });
      return marketplaceReceiptResponse(c.json(result), result);
    } catch {
      return c.json({ error: { code: "invalid_attempt" } }, 400);
    }
  });
  return app;
}
