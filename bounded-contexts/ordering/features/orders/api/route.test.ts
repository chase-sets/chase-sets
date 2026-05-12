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

  it("returns sign-in-required when guest confirmation hits account-scoped limits", async () => {
    const services = {
      ...createServices(),
      createOrdersFromCheckout: vi.fn(async () => {
        throw new Error(
          "Sign in is required to confirm checkout for listings with daily or customer purchase limits.",
        );
      }),
    } as unknown as OrderingOrderServices;
    const app = buildApp({
      actor: {
        sessionId: "guest:tok_1",
        tenantId: "tnt_identity",
        userId: "usr_guest_checkout",
        accountId: "acc_guest",
        membershipId: "guest:tok_1",
        roleKey: "guest-buyer",
        permissions: ["guest-checkout.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://ordering.test/account/purchases/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: "chk_1",
          sourceType: "cart-checkout",
          shippingOption: "standard",
          shippingAddress: {
            name: "Jane Smith",
            line1: "100 Market Street",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
          lines: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "account_sign_in_required",
        message:
          "Sign in is required to confirm checkout for listings with daily or customer purchase limits.",
      },
    });
    expect(services.createOrdersFromCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerAccountIsGuest: true,
      }),
      expect.anything(),
    );
  });
});
