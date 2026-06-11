import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import { createAccountListingRoutes, createPublicListingRoutes } from "./route";
import type { MarketplaceListingServices } from "./runtime";

function buildApp(
  options: Readonly<{
    actor: MarketplaceApiEnv["Variables"]["actor"];
    services: MarketplaceListingServices;
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

  app.route("/", createPublicListingRoutes(options.services));
  app.route("/account", createAccountListingRoutes(options.services));

  return app;
}

function createServices(): MarketplaceListingServices {
  return {
    createListing: vi.fn(async () => ({
      listingId: "lst_checkout_fallback" as never,
      version: 1,
      feeQuoteFingerprint: "12.00|0.60|11.40|cts_default|",
    })),
    createListingFromInventorySnapshot: vi.fn(async () => ({
      listingId: "lst_checkout_fallback" as never,
      version: 1,
      feeQuoteFingerprint: "12.00|0.60|11.40|cts_default|",
    })),
    previewPublicStandardListingTerms: vi.fn(async () => ({
      account_type: "personal",
      basis_amount: "20.00",
      marketplace_sales_fee_unit_amount: "1.95",
      seller_net_unit_amount: "18.05",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-17T00:00:00.000Z",
      resolved_at: "2026-04-17T00:00:00.000Z",
    })),
    createAnonymousListingDraftIntent: vi.fn(
      async (params: Parameters<MarketplaceListingServices["createAnonymousListingDraftIntent"]>[0]) => ({
        intent_id: "ldi_1",
        anonymous_owner_id: params.anonymousOwnerId,
        source_path: params.sourcePath,
        catalog_item_id: params.catalogItemId,
        product_id: params.productId,
        selected_options: params.selectedOptions,
        product_summary: params.productSummary ?? null,
        price_amount: params.priceAmount,
        quantity_cap: params.quantityCap,
        max_units_per_order: params.purchaseLimits?.maxUnitsPerOrder ?? null,
        max_units_per_day: params.purchaseLimits?.maxUnitsPerDay ?? null,
        max_units_per_customer_account: params.purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
        status: "active",
        claimed_account_id: null,
        claimed_at: null,
        expires_at: "2026-05-17T00:00:00.000Z",
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    ),
    getAnonymousListingDraftIntent: vi.fn(async () => null),
    claimAnonymousListingDraftIntent: vi.fn(
      async (params: Parameters<MarketplaceListingServices["claimAnonymousListingDraftIntent"]>[0]) => ({
        intent_id: params.intentId,
        anonymous_owner_id: params.anonymousOwnerId,
        source_path: "/items/charizard?market=sell",
        catalog_item_id: "cat_charizard",
        product_id: "cat_charizard::form:raw",
        selected_options: [{ dimensionId: "form", optionId: "raw" }],
        product_summary: "Form: Raw",
        price_amount: "20.00",
        quantity_cap: 1,
        max_units_per_order: null,
        max_units_per_day: null,
        max_units_per_customer_account: null,
        status: "claimed",
        claimed_account_id: params.accountId,
        claimed_at: "2026-04-17T00:00:00.000Z",
        expires_at: "2026-05-17T00:00:00.000Z",
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    ),
    publishListing: vi.fn(async () => ({ listingId: "lst_1", version: 2 })),
    listSellerListingFeeHistory: vi.fn(async () => [
      {
        event_type: "marketplace.listing.published",
        stream_version: 2,
        price_amount: null,
        quantity_cap: null,
        marketplace_sales_fee_unit_amount: "1.00",
        seller_net_unit_amount: "19.00",
        terms_schedule_id: "cts_default",
        terms_agreement_id: null,
        terms_resolved_at: "2026-04-17T00:00:00.000Z",
        fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
        recorded_at: "2026-04-17T00:00:00.000Z",
        performed_by_user_id: "usr_seller",
      },
    ]),
    listSellerListings: vi.fn(async () => ({ items: [], total: 0 })),
    getSellerListingAvailability: vi.fn(async () => ({
      account_id: "acc_seller",
      status: "available",
      disabled_reason_category: null,
      available_again_on: null,
      disabled_at: null,
      enabled_at: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    })),
    disableSellerListingAvailability: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 1,
      status: "unavailable",
    })),
    enableSellerListingAvailability: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 2,
      status: "available",
    })),
    listSellerListingFeeLockReport: vi.fn(async () => ({
      items: [
        {
          listing_id: "lst_1",
          inventory_item_id: "inv_1",
          item_title: "Charizard",
          product_summary: "Condition: Near Mint",
          status: "active",
          price_amount: "20.00",
          quantity_cap: 1,
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          terms_schedule_id: "cts_default",
          terms_agreement_id: null,
          terms_resolved_at: "2026-04-17T00:00:00.000Z",
          fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        },
      ],
      total: 1,
    })),
    listSellerInventoryItemSupply: vi.fn(async () => ({ items: [], total: 0 })),
    projectors: [],
  } as unknown as MarketplaceListingServices;
}

describe("marketplace listing routes", () => {
  it("returns display-safe public standard terms without requiring a signed-in actor", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/terms/public-standard/listing-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceAmount: "20.00" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      account_type: "personal",
      basis_amount: "20.00",
      marketplace_sales_fee_unit_amount: "1.95",
      seller_net_unit_amount: "18.05",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      resolved_at: "2026-04-17T00:00:00.000Z",
    });
    expect(body).not.toHaveProperty("fee_quote_fingerprint");
    expect(body).not.toHaveProperty("schedule_id");
    expect(body).not.toHaveProperty("agreement_id");
    expect(services.previewPublicStandardListingTerms).toHaveBeenCalledWith({
      priceAmount: "20.00",
    });
  });

  it("saves an anonymous listing draft intent without requiring a signed-in actor", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/guest/listing-draft-intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-marketplace-anonymous-listing-draft-id": "anon_listing_draft",
        },
        body: JSON.stringify({
          sourcePath: "/items/charizard?market=sell",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::form:raw",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Form: Raw",
          priceAmount: "20.00",
          quantityCap: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      intent_id: "ldi_1",
      anonymous_owner_id: "anon_listing_draft",
      catalog_item_id: "cat_charizard",
      price_amount: "20.00",
      status: "active",
    });
    expect(services.createAnonymousListingDraftIntent).toHaveBeenCalledWith({
      anonymousOwnerId: "anon_listing_draft",
      sourcePath: "/items/charizard?market=sell",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      priceAmount: "20.00",
      quantityCap: 1,
      purchaseLimits: {
        maxUnitsPerOrder: null,
        maxUnitsPerDay: null,
        maxUnitsPerCustomerAccount: null,
      },
    });
  });

  it("requires the anonymous owner header before saving a listing draft intent", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/guest/listing-draft-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceAmount: "20.00", quantityCap: 1 }),
      }),
    );

    expect(response.status).toBe(400);
    expect(services.createAnonymousListingDraftIntent).not.toHaveBeenCalled();
  });

  it("claims an anonymous listing draft intent for a signed-in seller", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-draft-intents/ldi_1/claim", {
        method: "POST",
        headers: {
          "x-marketplace-anonymous-listing-draft-id": "anon_listing_draft",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      intent_id: "ldi_1",
      status: "claimed",
      claimed_account_id: "acc_seller",
    });
    expect(services.claimAnonymousListingDraftIntent).toHaveBeenCalledWith({
      anonymousOwnerId: "anon_listing_draft",
      intentId: "ldi_1",
      accountId: "acc_seller",
    });
  });

  it("passes Checkout-provided deterministic listing IDs into seller listing creation", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inventoryItemId: "inv_1",
          priceAmount: "12.00",
          quantityCap: 1,
          listingIdOverride: "lst_checkout_fallback",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "lst_checkout_fallback",
      status: "draft",
    });
    expect(services.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        inventoryItemId: "inv_1",
        listingIdOverride: "lst_checkout_fallback",
      }),
      expect.any(Object),
    );
  });

  it("publishes a seller listing through the documented API action", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/publish", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "lst_1",
      version: 2,
      status: "published",
    });
    expect(services.publishListing).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        listingId: "lst_1",
        feeQuoteFingerprint: null,
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("returns listing fee history for the seller listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://marketplace.test/account/listings/lst_1/fee-history"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          event_type: "marketplace.listing.published",
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          performed_by_user_id: "usr_seller",
        },
      ],
    });
    expect(services.listSellerListingFeeHistory).toHaveBeenCalledWith({
      listingId: "lst_1",
      accountId: "acc_seller",
    });
  });

  it("returns marketplace sales fee lock report rows", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(new Request("http://marketplace.test/account/listings/fee-lock-report"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      count: 1,
      items: [
        {
          listing_id: "lst_1",
          marketplace_sales_fee_unit_amount: "1.00",
          seller_net_unit_amount: "19.00",
          fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
        },
      ],
    });
    expect(services.listSellerListingFeeLockReport).toHaveBeenCalledWith({
      accountId: "acc_seller",
      limit: 100,
      offset: 0,
    });
  });

  it("turns seller listing availability off for the acting account", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "owner",
        permissions: ["listings.view", "listings.manage"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listing-availability/disable", {
        method: "POST",
        body: JSON.stringify({
          reasonCategory: "audit",
          availableAgainOn: "2026-06-01",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 1,
      status: "unavailable",
    });
    expect(services.disableSellerListingAvailability).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        reasonCategory: "audit",
        availableAgainOn: "2026-06-01",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });
});
