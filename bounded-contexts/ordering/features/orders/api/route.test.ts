import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OrderingApiEnv } from "../../../api";
import { createAccountPurchaseOrderRoutes } from "./route";
import type { OrderingOrderServices } from "./runtime";

function buildApp(options: Readonly<{
  actor: OrderingApiEnv["Variables"]["actor"];
  services: OrderingOrderServices;
}>) {
  const app = new Hono<OrderingApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor
        ? {
            tenantId: "tnt_identity" as never,
            audit: {
              performedByUserId: options.actor.userId as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : null,
    );
    await next();
  });

  app.route("/account", createAccountPurchaseOrderRoutes(options.services));

  return app;
}

function createServices(): OrderingOrderServices {
  return {
    cancelPurchase: vi.fn(async () => ({ orderId: "ord_1", version: 3 })),
    listPurchases: vi.fn(async () => ({ items: [], total: 0 })),
    projectors: [],
  } as unknown as OrderingOrderServices;
}

describe("ordering purchase routes", () => {
  it("cancels a buyer purchase through the documented API action", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_buyer",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/ord_1/cancel", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "ord_1",
      version: 3,
      status: "cancelled",
    });
    expect(services.cancelPurchase).toHaveBeenCalledWith(
      {
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_buyer",
        }),
      }),
    );
  });
});
