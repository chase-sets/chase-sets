import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import { createAccountOfferMatchRoutes, createAccountSubmittedOfferRoutes } from "./route";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  createMarketplaceOfferRuntime,
  MarketplaceOfferFeeQuoteStaleError,
  type MarketplaceOfferServices,
} from "./runtime";
import { ManagedOfferConflictError } from "./managed-authority";
import { privatePolicyFields } from "../../offer-policy/tests/fixtures";

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

  return {
    commandHandler: vi.fn(async () => ({ version: 1 })),
    sellerControlCommandHandler: vi.fn(async () => ({ version: 1 })),
    submitOffer,
    acceptOffer,
    declineOfferMatch,
    previewOfferAcceptanceTerms,
    listSubmittedOffers,
    getSubmittedOffer,
    getPublicOffer,
    listOfferMatches,
    getOfferMatch,
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
      ...privatePolicyFields,
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
    for (const [key, value] of Object.entries(privatePolicyFields)) {
      expect(body).not.toHaveProperty(key);
      if (typeof value !== "object") expect(JSON.stringify(body)).not.toContain(String(value));
    }
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

  it.each(["managed_offer_held", "managed_offer_refresh_required", "managed_offer_conflict"] as const)(
    "returns private-safe retriable %s without accepting",
    async (code) => {
      const services = createServices();
      vi.mocked(services.acceptOffer).mockRejectedValue(new ManagedOfferConflictError(code));
      const app = buildApp({
        services,
        actor: {
          sessionId: "ses_1",
          tenantId: "tnt_identity",
          userId: "usr_1",
          accountId: "acc_seller",
          membershipId: "mbr_1",
          roleKey: "owner",
          permissions: ["offers.manage", "listings.view"],
        },
      });
      const response = await app.fetch(
        new Request("http://marketplace.test/account/offers/matches/off_1/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listingId: "lst_1", feeQuoteFingerprint: "old" }),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code, message: new ManagedOfferConflictError(code).message } });
      expect(services.acceptOffer).toHaveBeenCalledTimes(1);
    },
  );

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
        sourceActionKey: "",
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId: "decline_route_attempt_01" }),
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
        attemptId: "decline_route_attempt_01",
        offerId: "off_1",
        sellerAccountId: "acc_seller",
      },
      expect.any(Object),
    );
  });

  it.each([
    ["POST", "/account/offers/matches/off_1/mute-buyer"],
    ["GET", "/account/offers/mutes"],
    ["POST", "/account/offers/mutes/lst_1/acc_buyer/unmute"],
  ])("returns 404 for the retired %s %s route", async (method, path) => {
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

    const response = await app.fetch(new Request(`http://marketplace.test${path}`, { method }));

    expect(response.status).toBe(404);
  });
});

describe("buyer Offer lifecycle routes", () => {
  const actorFor = (accountId: string, permissions = ["offers.view", "offers.manage"]) => ({
    sessionId: `ses_${accountId}`,
    tenantId: "tnt_identity",
    userId: `usr_${accountId}`,
    accountId,
    membershipId: `mbr_${accountId}`,
    roleKey: "owner",
    permissions,
  });

  async function lifecycleApps(
    offerIds: Readonly<Record<string, string>>,
    lifecycleOpen = true,
    accountStatus: string | null = null,
  ) {
    const eventStore = createInMemoryEventStore().eventStore;
    const appendToStreams = vi.spyOn(eventStore, "appendToStreams");
    const appendToStream = vi.spyOn(eventStore, "appendToStream");
    const services = createMarketplaceOfferRuntime({
      ...(lifecycleOpen ? { offerLifecycleAdmission: { check: async () => ({ admitted: true }) as const } } : {}),
      eventStore,
      db: { query: vi.fn(async () => ({ rows: accountStatus ? [{ account_status: accountStatus }] : [] })) },
      checkpointStore: {} as never,
      commercialTermsResolver: {} as never,
    });
    for (const [offerId, buyerAccountId] of Object.entries(offerIds))
      await services.commandHandler({
        streamId: `marketplace.offer-${offerId}`,
        command: {
          type: "SubmitOffer",
          offerId: offerId as never,
          buyerAccountId: buyerAccountId as never,
          catalogItemId: "cat_charizard" as never,
          productId: "cat_charizard::" as never,
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          shippingDestinationSnapshot: {
            name: "Buyer",
            line1: "1 Main",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
          priceAmount: "350.00",
          priceCurrencyCode: "USD",
          quantityRequested: 1,
        },
        context: {
          tenantId: "tnt_identity" as never,
          audit: { performedByUserId: "usr_1" as never, forAccountId: buyerAccountId as never },
        },
      });
    appendToStream.mockClear();
    return {
      eventStore,
      writes: () => appendToStream.mock.calls.length + appendToStreams.mock.calls.length,
      buyer: buildApp({ actor: actorFor("acc_buyer"), services }),
      seller: buildApp({ actor: actorFor("acc_seller", ["offers.view", "offers.manage", "listings.view"]), services }),
    };
  }

  const post = (app: Hono<MarketplaceApiEnv>, path: string, body: Record<string, unknown> = {}) =>
    app.fetch(
      new Request(`http://marketplace.test/account${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const patchPrice = (app: Hono<MarketplaceApiEnv>, offerId: string, priceAmount: string) =>
    app.fetch(
      new Request(`http://marketplace.test/account/offers/submitted/${offerId}/price`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: "lifecycle_price_attempt_identity_01",
          priceAmount,
          priceCurrencyCode: "USD",
        }),
      }),
    );

  it("refuses every lifecycle producer with 503 offer_lifecycle_closed and no write until admission opens", async () => {
    const { buyer, writes } = await lifecycleApps({ off_1: "acc_buyer" }, false);
    for (const [path, body] of [
      ["/offers/submitted/off_1/pause", {}],
      ["/offers/submitted/off_1/resume", {}],
      ["/offers/submitted/off_1/withdraw", {}],
      ["/offers/submitted/bulk", { action: "withdraw", offerIds: ["off_1", "off_2"] }],
    ] as const) {
      const response = await post(buyer, path, body);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "offer_lifecycle_closed",
          message: "Pausing, resuming and withdrawing Offers is not open yet. Try again later.",
        },
      });
    }
    expect(writes()).toBe(0);
  });

  it("pauses, re-prices while paused, resumes and withdraws one Offer, reporting the real status", async () => {
    const { buyer, writes } = await lifecycleApps({ off_1: "acc_buyer" });
    const pause = await post(buyer, "/offers/submitted/off_1/pause");
    expect(pause.status).toBe(200);
    await expect(pause.json()).resolves.toEqual({ id: "off_1", version: 2, status: "paused", outcome: "changed" });
    await expect((await post(buyer, "/offers/submitted/off_1/pause")).json()).resolves.toMatchObject({
      status: "paused",
      outcome: "unchanged",
    });
    const repriced = await patchPrice(buyer, "off_1", "360.00");
    expect(repriced.status).toBe(200);
    await expect(repriced.json()).resolves.toEqual({ id: "off_1", version: 3, status: "paused" });
    await expect((await post(buyer, "/offers/submitted/off_1/resume")).json()).resolves.toEqual({
      id: "off_1",
      version: 4,
      status: "submitted",
      outcome: "changed",
    });
    await expect((await post(buyer, "/offers/submitted/off_1/withdraw")).json()).resolves.toMatchObject({
      status: "withdrawn",
      outcome: "changed",
    });
    const writesBeforeReplay = writes();
    const replay = await patchPrice(buyer, "off_1", "360.00");
    await expect(replay.json()).resolves.toEqual({ id: "off_1", version: 3, status: "paused" });
    expect(replay.headers.get("Chase-Sets-Commit-Receipt")).toBe(repriced.headers.get("Chase-Sets-Commit-Receipt"));
    expect(replay.headers.get("Chase-Sets-Commit-Receipt")).not.toBeNull();
    expect(writes()).toBe(writesBeforeReplay);
  });

  it("keeps a withdrawn Offer final: it cannot be resumed, re-priced or accepted", async () => {
    const { buyer, seller } = await lifecycleApps({ off_1: "acc_buyer" });
    await post(buyer, "/offers/submitted/off_1/withdraw");
    const resume = await post(buyer, "/offers/submitted/off_1/resume");
    expect(resume.status).toBe(409);
    await expect(resume.json()).resolves.toMatchObject({ error: { code: "offer_transition_rejected" } });
    const reprice = await patchPrice(buyer, "off_1", "360.00");
    expect(reprice.status).toBe(400);
    await expect(reprice.json()).resolves.toMatchObject({
      error: { code: "validation_failed", message: "Only open or paused Offers can change price." },
    });
    const accept = await post(seller, "/offers/matches/off_1/accept", {
      listingId: "lst_1",
      feeQuoteFingerprint: "x",
      sourceActionKey: "lifecycle_route_attempt_identity_01",
    });
    expect(accept.status).toBe(409);
    await expect(accept.json()).resolves.toMatchObject({ error: { code: "offer_not_open" } });
  });

  it("returns 409 offer_not_open when a seller accepts a paused Offer", async () => {
    const { buyer, seller } = await lifecycleApps({ off_1: "acc_buyer" });
    await post(buyer, "/offers/submitted/off_1/pause");
    const accept = await post(seller, "/offers/matches/off_1/accept", {
      listingId: "lst_1",
      feeQuoteFingerprint: "x",
      sourceActionKey: "lifecycle_route_attempt_identity_01",
    });
    expect(accept.status).toBe(409);
    await expect(accept.json()).resolves.toMatchObject({
      error: { code: "offer_not_open", details: { status: "paused" } },
    });
  });

  it("hides the counterparty status when accepting a suspended Offer", async () => {
    const { seller } = await lifecycleApps({ off_1: "acc_buyer" }, true, "suspended");
    const accept = await post(seller, "/offers/matches/off_1/accept", {
      listingId: "lst_1",
      feeQuoteFingerprint: "x",
      sourceActionKey: "lifecycle_route_attempt_identity_01",
    });
    expect(accept.status).toBe(409);
    const body = await accept.json();
    expect(body).toMatchObject({ error: { code: "offer_not_open" } });
    expect(body.error.details).not.toHaveProperty("accountStatus");
  });

  it("returns 409 offer_not_open when the buyer mirror is missing", async () => {
    const { seller } = await lifecycleApps({ off_1: "acc_buyer" }, true, null);
    const accept = await post(seller, "/offers/matches/off_1/accept", {
      listingId: "lst_1",
      feeQuoteFingerprint: "x",
      sourceActionKey: "lifecycle_route_attempt_identity_01",
    });
    expect(accept.status).toBe(409);
    await expect(accept.json()).resolves.toMatchObject({ error: { code: "offer_not_open" } });
  });

  it("hides another buyer's Offer from single lifecycle commands", async () => {
    const { buyer, eventStore } = await lifecycleApps({ off_other: "acc_other" });
    const response = await post(buyer, "/offers/submitted/off_other/withdraw");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    expect((await eventStore.readStream({ streamId: "marketplace.offer-off_other" })).at(-1)?.eventType).toBe(
      "marketplace.offer.submitted",
    );
  });

  it("returns one outcome per row for 250 mixed IDs and rejects another buyer's Offer as not_found", async () => {
    const offers: Record<string, string> = { off_other: "acc_other" };
    for (let index = 0; index < 200; index++) offers[`off_${String(index).padStart(3, "0")}`] = "acc_buyer";
    const { buyer, eventStore } = await lifecycleApps(offers);
    await post(buyer, "/offers/submitted/off_000/pause");
    await post(buyer, "/offers/submitted/off_001/withdraw");
    const offerIds = [
      ...Array.from({ length: 200 }, (_, index) => `off_${String(index).padStart(3, "0")}`),
      "off_other",
      ...Array.from({ length: 49 }, (_, index) => `off_missing_${index}`),
    ];
    const response = await post(buyer, "/offers/submitted/bulk", { action: "pause", offerIds });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { offerId: string; outcome: string; code?: string }[] };
    expect(body.items).toHaveLength(250);
    expect(body.items.map((item) => item.offerId)).toEqual(offerIds);
    expect(body.items[0]).toMatchObject({ offerId: "off_000", outcome: "unchanged", status: "paused" });
    expect(body.items[1]).toEqual({ offerId: "off_001", outcome: "rejected", code: "offer_transition_rejected" });
    expect(body.items[2]).toMatchObject({ offerId: "off_002", outcome: "changed", status: "paused" });
    expect(body.items[200]).toEqual({ offerId: "off_other", outcome: "rejected", code: "not_found" });
    expect(body.items.slice(201).every((item) => item.outcome === "rejected" && item.code === "not_found")).toBe(true);
    expect(body.items.filter((item) => item.outcome === "changed")).toHaveLength(198);
    expect((await eventStore.readStream({ streamId: "marketplace.offer-off_other" })).at(-1)?.eventType).toBe(
      "marketplace.offer.submitted",
    );
  });

  it.each([
    ["251 IDs", { action: "pause", offerIds: Array.from({ length: 251 }, (_, index) => `off_${index}`) }],
    ["no IDs", { action: "pause", offerIds: [] }],
    ["an unknown action", { action: "accept", offerIds: ["off_1"] }],
    ["a malformed ID", { action: "pause", offerIds: ["off_1", "lst_1"] }],
  ])("rejects a bulk request with %s as 400 before any write", async (_label, body) => {
    const { buyer, writes } = await lifecycleApps({ off_1: "acc_buyer" });
    const response = await post(buyer, "/offers/submitted/bulk", body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "validation_failed" } });
    expect(writes()).toBe(0);
  });

  it("passes the status filter through and returns per-status counts", async () => {
    const services = createServices();
    vi.mocked(services.listSubmittedOffers).mockResolvedValue({
      items: [],
      total: 2,
      statusCounts: { submitted: 3, paused: 2, withdrawn: 1, accepted: 0 },
    });
    const app = buildApp({ actor: actorFor("acc_buyer"), services });
    const response = await app.fetch(new Request("http://marketplace.test/account/offers/submitted?status=paused"));
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      statusCounts: { submitted: 3, paused: 2, withdrawn: 1, accepted: 0 },
    });
    expect(services.listSubmittedOffers).toHaveBeenCalledWith(
      expect.objectContaining({ buyerAccountId: "acc_buyer", status: "paused" }),
    );
    await app.fetch(new Request("http://marketplace.test/account/offers/submitted?status=bogus"));
    expect(services.listSubmittedOffers).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }));
  });
});
