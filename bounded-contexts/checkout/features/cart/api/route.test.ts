import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutApiEnv } from "../../../api";
import { createAccountCartRoutes } from "./route";
import type { CheckoutCartServices } from "./runtime";

function buildApp(options: Readonly<{
  actor: CheckoutApiEnv["Variables"]["actor"];
  services: CheckoutCartServices;
}>) {
  const app = new Hono<CheckoutApiEnv>();

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

  app.route("/account", createAccountCartRoutes(options.services));

  return app;
}

function createServices(): CheckoutCartServices {
  return {
    addLine: vi.fn(async () => ({ lineId: "cli_1" as never, version: 1 })),
    setLineQuantity: vi.fn(async () => ({ lineId: "cli_1" as never, version: 2 })),
    removeLine: vi.fn(async () => ({ lineId: "cli_1" as never, version: 3 })),
    listCartLines: vi.fn(async () => []),
    projectors: [],
  } as unknown as CheckoutCartServices;
}

describe("checkout cart routes", () => {
  it("adds a browsed marketplace item to the current account cart", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["orders.view", "orders.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://checkout.test/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          quantity: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "cli_1",
      version: 1,
      status: "added",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_buyer",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form=raw",
        quantity: 2,
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_buyer",
          performedByUserId: "usr_1",
        }),
      }),
    );
  });
});
