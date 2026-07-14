import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import { createAccountOfferMatchRoutes, createAccountSubmittedOfferRoutes } from "./route";
import { MarketplaceOfferFeeQuoteStaleError, type MarketplaceOfferServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: MarketplaceApiEnv["Variables"]["actor"];
    services: MarketplaceOfferServices;
  }>,
) {
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
  const acceptOffer = vi.fn(async () => ({
    offerId: "off_1" as never,
    listingId: "lst_1",
    inventoryItemId: "inv_1",
    listingEvidenceSnapshot: {
      schemaVersion: 1 as const,
      policyHash: "sha256:policy",
      snapshotHash: "sha256:evidence",
      createdAt: "2026-03-31T00:00:00.000Z",
      evidence: [],
    },
    version: 2,
  }));
  const declineOfferMatch = vi.fn(async () => ({ offerId: "off_1" as never, version: 3 }));
  const muteBuyerOffers = vi.fn(async () => ({ offerId: "off_1" as never, version: 4 }));
  const unmuteBuyerOffers = vi.fn(async () => ({
    listingId: "lst_1",
    buyerAccountId: "acc_buyer" as never,
    version: 5,
  }));
  const previewOfferAcceptanceTerms = vi.fn(async () => ({
    account_type: "personal" as const,
    basis_amount: "350.00",
    marketplace_sales_fee_unit_amount: "17.50",
    seller_net_unit_amount: "332.50",
    schedule_id: "sch_standard",
    agreement_id: null,
    resolved_at: "2026-03-31T00:00:00.000Z",
    fee_quote_fingerprint: "350.00|17.50|332.50|sch_standard|",
  }));
  const listSubmittedOffers = vi.fn(async () => ({ items: [], total: 0 }));
  const getSubmittedOffer = vi.fn(async () => null);
  const getPublicOffer = vi.fn(async () => null);
  const listOfferMatches = vi.fn(async () => ({ items: [], total: 0 }));
  const getOfferMatch = vi.fn(async () => null);
  const listOfferBuyerMutes = vi.fn(async () => ({ items: [], total: 0 }));

  return {
    commandHandler: vi.fn(async () => ({ version: 1 })),
    sellerControlCommandHandler: vi.fn(async () => ({ version: 1 })),
    submitOffer,
    acceptOffer,
    declineOfferMatch,
    muteBuyerOffers,
    unmuteBuyerOffers,
    previewOfferAcceptanceTerms,
    listSubmittedOffers,
    getSubmittedOffer,
    getPublicOffer,
    listOfferMatches,
    getOfferMatch,
    listOfferBuyerMutes,
    projectors: [],
  } as unknown as MarketplaceOfferServices;
}

const submittedOfferWithPrivateDestination = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "form", optionId: "raw" }],
  product_summary: "Form: Raw",
  shipping_destination_snapshot: {
    name: "Private Buyer",
    line1: "100 Market Street",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
    email: "alternate-contact@example.test",
    phone: "3125550100",
  },
  price_amount: "350.00",
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-03-31T00:00:00.000Z",
  updated_at: "2026-03-31T00:00:00.000Z",
};

describe("marketplace offer routes", () => {
  it("passes product and fulfillability filters to the offer match source list", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["offers.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request(
        "http://marketplace.test/account/offers/matches?limit=75&offset=5&productIds=prod_1,prod_2&status=submitted&canFulfill=true",
      ),
    );

    expect(response.status).toBe(200);
    expect(services.listOfferMatches).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      limit: 75,
      offset: 5,
      productIds: ["prod_1", "prod_2"],
      status: "submitted",
      canFulfill: true,
    });
  });

  it("submits an offer for any signed-in account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: [],
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

  it("rate limits repeated offer submissions for one account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_limited_offer_buyer",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: [],
      },
      services,
    });

    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const response = await app.fetch(
        new Request("http://marketplace.test/account/offers/submitted", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": `198.51.100.${attempt}`,
          },
          body: JSON.stringify({
            catalogItemId: "cat_charizard",
            productId: "cat_charizard::",
            itemTitle: "Charizard",
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            priceAmount: "350.00",
            quantityRequested: 1,
          }),
        }),
      );
      expect(response.status).toBe(201);
    }

    const limited = await app.fetch(
      new Request("http://marketplace.test/account/offers/submitted", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "198.51.100.200",
        },
        body: JSON.stringify({
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::",
          itemTitle: "Charizard",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          priceAmount: "350.00",
          quantityRequested: 1,
        }),
      }),
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    await expect(limited.json()).resolves.toMatchObject({
      error: {
        code: "rate_limited",
        surface: "marketplace.offer.submit.account",
      },
    });
  });

  it("omits private shipping destination snapshots from submitted offer responses", async () => {
    const services = createServices();
    vi.mocked(services.listSubmittedOffers).mockResolvedValue({
      items: [submittedOfferWithPrivateDestination],
      total: 1,
    } as never);
    vi.mocked(services.getSubmittedOffer).mockResolvedValue(submittedOfferWithPrivateDestination as never);
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_1",
        accountId: "acc_buyer",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["offers.view"],
      },
      services,
    });

    const listResponse = await app.fetch(new Request("http://marketplace.test/account/offers/submitted"));
    const listBody = (await listResponse.json()) as { items: unknown[] };
    const detailResponse = await app.fetch(new Request("http://marketplace.test/account/offers/submitted/off_1"));
    const detailBody = await detailResponse.json();

    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(listBody.items[0]).not.toHaveProperty("shipping_destination_snapshot");
    expect(detailBody).not.toHaveProperty("shipping_destination_snapshot");
    expect(JSON.stringify({ listBody, detailBody })).not.toContain("alternate-contact@example.test");
  });

  it("returns a public submitted offer for seller selected-offer resolution without private destination data", async () => {
    const services = createServices();
    vi.mocked(services.getPublicOffer).mockResolvedValue({
      ...submittedOfferWithPrivateDestination,
      offer_id: "off_air_balloon",
      catalog_catalog_item_id: "cat_air_balloon",
      product_id: "cat_air_balloon::condition:damaged|form:raw",
      item_title: "Air Balloon",
      item_subtitle: null,
      selected_options: [
        { dimensionId: "condition", optionId: "damaged" },
        { dimensionId: "form", optionId: "raw" },
      ],
      product_summary: "Raw / Damaged",
      price_amount: "24.96",
      quantity_requested: 1,
      status: "submitted",
      accepted_seller_account_id: null,
      accepted_at: null,
    } as never);
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

    const response = await app.fetch(new Request("http://marketplace.test/account/offers/public/off_air_balloon"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      offer_id: "off_air_balloon",
      status: "submitted",
      product_id: "cat_air_balloon::condition:damaged|form:raw",
      price_amount: "24.96",
    });
    expect(body).not.toHaveProperty("shipping_destination_snapshot");
    expect(JSON.stringify(body)).not.toContain("alternate-contact@example.test");
    expect(services.getPublicOffer).toHaveBeenCalledWith("off_air_balloon");
  });

  it("rejects anonymous offer submission", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
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
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          priceAmount: "350.00",
          quantityRequested: 1,
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authentication_required",
        message: "Authentication required.",
      },
    });
    expect(services.submitOffer).not.toHaveBeenCalled();
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

    const response = await app.fetch(new Request("http://marketplace.test/account/offers/submitted"));

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
      ...submittedOfferWithPrivateDestination,
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
      listing_id: "lst_1",
      listing_price_amount: "375.00",
      listing_quantity_cap: 1,
      listing_visible_quantity: 1,
      offer_price_gap_amount: "25.00",
      offer_to_listing_price_bps: 9333,
      buyer_display_name: "Buyer One",
      seller_available_quantity: 1,
      seller_listing_availability_status: "available",
      can_fulfill: true,
      created_at: "2026-03-31T00:00:00.000Z",
      updated_at: "2026-03-31T00:00:00.000Z",
    } as never);

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

    const response = await app.fetch(new Request("http://marketplace.test/account/offers/matches/off_1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      offer_id: "off_1",
      buyer_display_name: "Buyer One",
    });
    expect(body).not.toHaveProperty("shipping_destination_snapshot");
    expect(JSON.stringify(body)).not.toContain("alternate-contact@example.test");
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
        body: JSON.stringify({
          listingId: "lst_1",
          feeQuoteFingerprint: "350.00|17.50|332.50|sch_standard|",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "off_1",
      listingId: "lst_1",
      inventoryItemId: "inv_1",
      evidenceSnapshotHash: "sha256:evidence",
      version: 2,
      status: "accepted",
    });
    expect(services.acceptOffer).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_seller",
        listingId: "lst_1",
        feeQuoteFingerprint: "350.00|17.50|332.50|sch_standard|",
        sourceActionKey: null,
        acceptanceBatchId: null,
        acceptanceBatchSize: null,
      },
      expect.any(Object),
    );
  });

  it("returns a stale quote response when an offer acceptance confirmation is missing", async () => {
    const services = createServices();
    vi.mocked(services.acceptOffer).mockRejectedValue(
      new MarketplaceOfferFeeQuoteStaleError({
        account_type: "personal",
        basis_amount: "350.00",
        marketplace_sales_fee_unit_amount: "17.50",
        seller_net_unit_amount: "332.50",
        schedule_id: "sch_standard",
        agreement_id: null,
        resolved_at: "2026-03-31T00:00:00.000Z",
        fee_quote_fingerprint: "350.00|17.50|332.50|sch_standard|",
      } as never),
    );
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
        body: JSON.stringify({ listingId: "lst_1" }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "fee_quote_stale",
        currentQuote: {
          fee_quote_fingerprint: "350.00|17.50|332.50|sch_standard|",
        },
      },
    });
  });

  it("declines an offer match", async () => {
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
      new Request("http://marketplace.test/account/offers/matches/off_1/decline", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "off_1",
      version: 3,
      status: "declined",
    });
    expect(services.declineOfferMatch).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
  });

  it("mutes offer matches from a buyer", async () => {
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
      new Request("http://marketplace.test/account/offers/matches/off_1/mute-buyer", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "off_1",
      version: 4,
      status: "muted",
    });
    expect(services.muteBuyerOffers).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
  });

  it("returns and removes muted offer buyers", async () => {
    const services = createServices();
    vi.mocked(services.listOfferBuyerMutes).mockResolvedValue({
      items: [
        {
          seller_account_id: "acc_seller",
          buyer_account_id: "acc_buyer",
          buyer_display_name: "Buyer One",
          listing_id: "lst_1",
          product_id: "cat_charizard::",
          muted_at: "2026-07-05T12:00:00.000Z",
          updated_at: "2026-07-05T12:00:00.000Z",
        },
      ],
      total: 1,
    });
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

    const listResponse = await app.fetch(new Request("http://marketplace.test/account/offers/mutes"));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      count: 1,
      items: [{ buyer_account_id: "acc_buyer", listing_id: "lst_1" }],
    });

    const unmuteResponse = await app.fetch(
      new Request("http://marketplace.test/account/offers/mutes/lst_1/acc_buyer/unmute", {
        method: "POST",
      }),
    );
    expect(unmuteResponse.status).toBe(201);
    await expect(unmuteResponse.json()).resolves.toEqual({
      listingId: "lst_1",
      buyerAccountId: "acc_buyer",
      version: 5,
      status: "unmuted",
    });
    expect(services.unmuteBuyerOffers).toHaveBeenCalledWith(
      {
        listingId: "lst_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
  });
});
