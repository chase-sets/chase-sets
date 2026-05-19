import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutApiEnv } from "../../../api";
import { createAccountSellListRoutes } from "./route";
import type { CheckoutSellListServices } from "./runtime";

function buildApp(options: Readonly<{
  actor: CheckoutApiEnv["Variables"]["actor"];
  services: CheckoutSellListServices;
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

  app.route("/account", createAccountSellListRoutes(options.services));

  return app;
}

function createServices(): CheckoutSellListServices {
  return {
    addLine: vi.fn(async () => ({ lineId: "sll_1" as never, version: 1, status: "added" })),
    removeLine: vi.fn(async () => ({ lineId: "sll_1" as never, version: 2 })),
    listLines: vi.fn(async () => []),
    projectors: [],
  } as unknown as CheckoutSellListServices;
}

function sellerActor(): CheckoutApiEnv["Variables"]["actor"] {
  return {
    sessionId: "ses_1",
    tenantId: "tnt_identity",
    userId: "usr_seller",
    accountId: "acc_seller",
    membershipId: "mbr_seller",
    roleKey: "owner",
    permissions: ["listings.view", "offers.view"],
  };
}

function guestCheckoutActor(): CheckoutApiEnv["Variables"]["actor"] {
  return {
    sessionId: "guest:tok_1",
    tenantId: "tnt_identity",
    userId: "usr_guest_checkout",
    accountId: "acc_guest",
    membershipId: "guest:tok_1",
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  };
}

describe("checkout sell list routes", () => {
  it("counts sell list item quantities instead of raw lines", async () => {
    const services = createServices();
    vi.mocked(services.listLines).mockResolvedValue([
      { line_id: "sll_1", quantity: 2 },
      { line_id: "sll_2", quantity: 3 },
    ] as never);
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list"),
    );

    await expect(response.json()).resolves.toMatchObject({
      count: 5,
    });
  });

  it("adds product-level seller intent to the Checkout-owned Sell List", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "product",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          quantity: 2,
          fallbackMode: "create-listing",
          minimumListingPriceAmount: "399.00",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "sll_1",
      version: 1,
      status: "added",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineType: "product",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form=raw",
        quantity: 2,
        fallbackMode: "create-listing",
        minimumListingPriceAmount: "399.00",
      }),
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("adds a selected offer line to the Checkout-owned Sell List", async () => {
    const services = createServices();
    vi.mocked(services.addLine).mockResolvedValue({
      lineId: "sll_offer" as never,
      version: 4,
      status: "merged",
    });
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "selected-offer",
          offerId: "off_charizard",
          buyerAccountId: "acc_buyer",
          buyerDisplayName: "Ash Ketchum",
          offerPriceAmount: "350.00",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "sll_offer",
      version: 4,
      status: "merged",
    });
    expect(services.addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineType: "selected-offer",
        offerId: "off_charizard",
        buyerAccountId: "acc_buyer",
        buyerDisplayName: "Ash Ketchum",
        offerPriceAmount: "350.00",
      }),
      expect.any(Object),
    );
  });

  it("removes a Sell List line", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list/sll_1/remove", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "sll_1",
      version: 2,
      status: "removed",
    });
    expect(services.removeLine).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_seller",
        lineId: "sll_1",
      }),
      expect.any(Object),
    );
  });

  it("blocks guest checkout actors from seller Sell List review", async () => {
    const services = createServices();
    const app = buildApp({ actor: guestCheckoutActor(), services });

    const response = await app.fetch(
      new Request("http://checkout.test/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineType: "product",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form=raw",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "authorization_forbidden",
        message: "Sell List review requires a seller account.",
      },
    });
    expect(services.addLine).not.toHaveBeenCalled();
  });
});
