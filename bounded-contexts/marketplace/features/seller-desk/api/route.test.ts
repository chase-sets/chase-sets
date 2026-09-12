import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import type { SellerAttentionQueuePort } from "../read-model/runtime";
import { createSellerAttentionQueueRoutes } from "./route";

const permissions = [
  "inventory.view",
  "listings.view",
  "offers.view",
  "fulfillment.view",
  "payouts.view",
  "channels.view",
] as const;

describe("Seller Desk canonical queue HTTP route", () => {
  it("loads the same production queue for the authenticated account", async () => {
    const loadQueue = vi.fn(async () => ({
      items: [],
      rollup: {
        total: 0,
        bySeverity: { critical: 0, warning: 0, info: 0 },
        bySource: {
          "fulfillment-ship-by": 0,
          "settlement-blocked-payout": 0,
          "dispute-response": 0,
          "inventory-resolution": 0,
          "channel-action": 0,
          "offer-response": 0,
          "listing-action": 0,
        },
      },
      sources: [],
      degraded: false,
    }));
    const response = await app(loadQueue, permissions).request("http://local/account/seller-attention-queue");
    expect(response.status).toBe(200);
    expect(loadQueue).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc_owner" }));
  });

  it("refuses a caller missing Channels visibility before the queue read", async () => {
    const loadQueue = vi.fn();
    const response = await app(
      loadQueue,
      permissions.filter((permission) => permission !== "channels.view"),
    ).request("http://local/account/seller-attention-queue");
    expect(response.status).toBe(403);
    expect(loadQueue).not.toHaveBeenCalled();
  });
});

function app(loadQueue: SellerAttentionQueuePort["loadQueue"], actorPermissions: readonly string[]) {
  const app = new Hono<MarketplaceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "sess" as never,
      tenantId: "tnt" as never,
      userId: "usr" as never,
      accountId: "acc_owner" as never,
      membershipId: "mem" as never,
      roleKey: "manager",
      permissions: actorPermissions,
    });
    await next();
  });
  app.route("/account/seller-attention-queue", createSellerAttentionQueueRoutes({ loadQueue }));
  return app;
}
