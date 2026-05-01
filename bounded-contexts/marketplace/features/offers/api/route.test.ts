import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import {
  createAccountOfferMatchRoutes,
  createAccountSubmittedOfferRoutes,
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

  app.route("/account", createAccountSubmittedOfferRoutes(options.services));
  app.route("/account", createAccountOfferMatchRoutes(options.services));

  return app;
}

function createServices(): MarketplaceOfferServices {
  const submitOffer = vi.fn(async () => ({ offerId: "off_1" as never, version: 1 }));
  const acceptOffer = vi.fn(async () => ({ offerId: "off_1" as never, version: 2 }));
  const listSubmittedOffers = vi.fn(async () => ({ items: [], total: 0 }));
  const getSubmittedOffer = vi.fn(async () => null);
  const listOfferMatches = vi.fn(async () => ({ items: [], total: 0 }));
  const getOfferMatch = vi.fn(async () => null);
  const addOfferMatchSellListItem = vi.fn(async () => undefined);
  const listOfferMatchSellList = vi.fn(async () => []);
  const acceptOfferMatchSellList = vi.fn(async () => ({
    acceptedOfferIds: ["off_1" as never],
    skipped: [],
  }));

  return {
    commandHandler: vi.fn(async () => ({ version: 1 })),
    submitOffer,
    acceptOffer,
    addOfferMatchSellListItem,
    listOfferMatchSellList,
    acceptOfferMatchSellList,
    listSubmittedOffers,
    getSubmittedOffer,
    listOfferMatches,
    getOfferMatch,
    projectors: [],
  };
}

describe("marketplace offer routes", () => {
  it("submits an offer for the current account", async () => {
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
      new Request("http://marketplace.test/account/offers/submitted", {
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
    await expect(response.json()).resolves.toEqual({
      id: "off_1",
      version: 1,
      status: "submitted",
    });
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
      new Request("http://marketplace.test/account/offers/submitted"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authorization_forbidden",
        message: "Forbidden.",
      },
    });
  });

  it("returns offer matches from the matching demand board", async () => {
    const services = createServices();
    vi.mocked(services.getOfferMatch).mockResolvedValue({
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
      new Request("http://marketplace.test/account/offers/matches/off_1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      offer_id: "off_1",
      buyer_display_name: "Buyer One",
    });
    expect(services.getOfferMatch).toHaveBeenCalledWith("off_1", "acc_seller");
  });

  it("accepts a offer match", async () => {
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
      new Request("http://marketplace.test/account/offers/matches/off_1/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "off_1",
      version: 2,
      status: "accepted",
    });
    expect(services.acceptOffer).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
  });

  it("adds a offer match to the sell list", async () => {
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
      new Request("http://marketplace.test/account/offers/match-sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId: "off_1" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.addOfferMatchSellListItem).toHaveBeenCalledWith({
      offerId: "off_1",
      sellerAccountId: "acc_seller",
    });
  });

  it("accepts the offer match sell list", async () => {
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
      new Request("http://marketplace.test/account/offers/match-sell-list/accept", {
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
    expect(services.acceptOfferMatchSellList).toHaveBeenCalledWith(
      { sellerAccountId: "acc_seller" },
      expect.any(Object),
    );
  });
});
