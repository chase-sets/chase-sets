import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import {
  createBuyerOfferMatchRoutes,
  createSubmittedBuyerOfferRoutes,
} from "./route";
import type { MarketplaceOfferServices } from "./runtime";

function buildApp(options: Readonly<{
  actor: MarketplaceApiEnv["Variables"]["actor"];
  services: MarketplaceOfferServices;
}>) {
  const app = new Hono<MarketplaceApiEnv>();

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

  app.route("/buyer", createSubmittedBuyerOfferRoutes(options.services));
  app.route("/seller", createBuyerOfferMatchRoutes(options.services));

  return app;
}

function createServices(): MarketplaceOfferServices {
  const submitOffer = vi.fn(async () => ({ offerId: "off_1" as never, version: 1 }));
  const acceptOffer = vi.fn(async () => ({ offerId: "off_1" as never, version: 2 }));
  const listSubmittedBuyerOffers = vi.fn(async () => ({ items: [], total: 0 }));
  const getSubmittedBuyerOffer = vi.fn(async () => null);
  const listBuyerOfferMatches = vi.fn(async () => ({ items: [], total: 0 }));
  const getBuyerOfferMatch = vi.fn(async () => null);
  const addBuyerOfferMatchSellListItem = vi.fn(async () => undefined);
  const listBuyerOfferMatchSellList = vi.fn(async () => []);
  const acceptBuyerOfferMatchSellList = vi.fn(async () => ({
    acceptedOfferIds: ["off_1" as never],
    skipped: [],
  }));

  return {
    commandHandler: vi.fn(async () => ({ version: 1 })),
    submitOffer,
    acceptOffer,
    addBuyerOfferMatchSellListItem,
    listBuyerOfferMatchSellList,
    acceptBuyerOfferMatchSellList,
    listSubmittedBuyerOffers,
    getSubmittedBuyerOffer,
    listBuyerOfferMatches,
    getBuyerOfferMatch,
    projectors: [],
  };
}

describe("marketplace offer routes", () => {
  it("submits a buyer offer for the current account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["offers.view", "offers.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/buyer/submitted-buyer-offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          priceAmount: "350.00",
          quantityRequested: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "off_1", version: 1 });
    expect(services.submitOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerAccountId: "acc_buyer",
        catalogItemId: "cat_charizard",
        priceAmount: "350.00",
      }),
      expect.any(Object),
    );
  });

  it("enforces offer permissions on buyer list routes", async () => {
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["offers.manage"],
      },
      services: createServices(),
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/buyer/submitted-buyer-offers"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
  });

  it("returns buyer offer matches from the matching demand board", async () => {
    const services = createServices();
    vi.mocked(services.getBuyerOfferMatch).mockResolvedValue({
      offer_id: "off_1",
      buyer_account_id: "acc_buyer",
      catalog_catalog_item_id: "cat_charizard",
      product_id: "cat_charizard::",
      item_title: "Charizard",
      item_subtitle: "Base Set 4/102 Holo Rare",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Form: Raw",
      price_amount: "350.00",
      quantity_requested: 1,
      status: "submitted",
      accepted_seller_account_id: null,
      accepted_at: null,
      buyer_display_name: "Buyer One",
      seller_available_quantity: 1,
      can_fulfill: true,
      in_sell_list: false,
      created_at: "2026-03-31T00:00:00.000Z",
      updated_at: "2026-03-31T00:00:00.000Z",
    });

    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["offers.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/seller/buyer-offer-matches/off_1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      offer_id: "off_1",
      buyer_display_name: "Buyer One",
    });
    expect(services.getBuyerOfferMatch).toHaveBeenCalledWith("off_1", "acc_seller");
  });

  it("accepts a buyer offer match", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["offers.view", "offers.manage", "listings.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/seller/buyer-offer-matches/off_1/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "off_1", version: 2 });
    expect(services.acceptOffer).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
  });

  it("adds a buyer offer match to the sell list", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["offers.view", "offers.manage", "listings.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/seller/buyer-offer-match-sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId: "off_1" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addBuyerOfferMatchSellListItem).toHaveBeenCalledWith({
      offerId: "off_1",
      sellerAccountId: "acc_seller",
    });
  });

  it("accepts the buyer offer match sell list", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["offers.view", "offers.manage", "listings.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/seller/buyer-offer-match-sell-list/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      acceptedOfferIds: ["off_1"],
      skipped: [],
    });
    expect(services.acceptBuyerOfferMatchSellList).toHaveBeenCalledWith(
      { sellerAccountId: "acc_seller" },
      expect.any(Object),
    );
  });
});
