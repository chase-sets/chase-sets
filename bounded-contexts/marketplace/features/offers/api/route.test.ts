import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import {
  createBuyerOfferRoutes,
  createSellerOfferRoutes,
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

  app.route("/buyer", createBuyerOfferRoutes(options.services));
  app.route("/seller", createSellerOfferRoutes(options.services));

  return app;
}

function createServices(): MarketplaceOfferServices {
  const submitOffer = vi.fn(async () => ({ offerId: "off_1" as never, version: 1 }));
  const acceptOffer = vi.fn(async () => ({ offerId: "off_1" as never, version: 2 }));
  const listBuyerOffers = vi.fn(async () => ({ items: [], total: 0 }));
  const getBuyerOffer = vi.fn(async () => null);
  const listSellerVisibleOffers = vi.fn(async () => ({ items: [], total: 0 }));
  const getSellerVisibleOffer = vi.fn(async () => null);

  return {
    commandHandler: vi.fn(async () => ({ version: 1 })),
    submitOffer,
    acceptOffer,
    listBuyerOffers,
    getBuyerOffer,
    listSellerVisibleOffers,
    getSellerVisibleOffer,
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
      new Request("http://marketplace.test/buyer/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          catalogVersionKey: "cat_charizard::",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set 4/102 Holo Rare",
          versionSelection: [{ dimensionId: "form", choiceId: "raw" }],
          versionSummary: "Form: Raw",
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
      new Request("http://marketplace.test/buyer/offers"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
  });

  it("returns seller-visible offers from the matching demand board", async () => {
    const services = createServices();
    vi.mocked(services.getSellerVisibleOffer).mockResolvedValue({
      offer_id: "off_1",
      buyer_account_id: "acc_buyer",
      catalog_item_id: "cat_charizard",
      catalog_version_key: "cat_charizard::",
      item_title: "Charizard",
      item_subtitle: "Base Set 4/102 Holo Rare",
      version_selection: [{ dimensionId: "form", choiceId: "raw" }],
      version_summary: "Form: Raw",
      price_amount: "350.00",
      quantity_requested: 1,
      status: "submitted",
      accepted_seller_account_id: null,
      accepted_at: null,
      buyer_display_name: "Buyer One",
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
      new Request("http://marketplace.test/seller/offers/off_1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      offer_id: "off_1",
      buyer_display_name: "Buyer One",
    });
    expect(services.getSellerVisibleOffer).toHaveBeenCalledWith("off_1", "acc_seller");
  });

  it("accepts a seller-visible offer", async () => {
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
      new Request("http://marketplace.test/seller/offers/off_1/accept", {
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
});
