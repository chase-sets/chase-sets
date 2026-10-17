import { Hono } from "hono";
import type { MarketplaceApiEnv } from "../../../api";
import type { SellerAttentionQueuePort } from "../read-model/runtime";

const REQUIRED_PERMISSIONS = [
  "inventory.view",
  "listings.view",
  "offers.view",
  "fulfillment.view",
  "payouts.view",
  "channels.view",
] as const;

export function createSellerAttentionQueueRoutes(queue: SellerAttentionQueuePort) {
  const app = new Hono<MarketplaceApiEnv>();
  app.get("/", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required", message: "authentication_required" } }, 401);
    if (REQUIRED_PERMISSIONS.some((permission) => !actor.permissions.includes(permission))) {
      return c.json({ error: { code: "authorization_forbidden", message: "authorization_forbidden" } }, 403);
    }
    return c.json(await queue.loadQueue({ accountId: actor.accountId, now: new Date().toISOString() }));
  });
  return app;
}
