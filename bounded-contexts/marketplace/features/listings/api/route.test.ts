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
      available_again_at: null,
      disabled_at: null,
      enabled_at: null,
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
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
    getSellerOrderCapacity: vi.fn(async () => ({
      account_id: "acc_seller",
      max_open_orders: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    })),
    setSellerOrderCapacity: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 1,
      maxOpenOrders: 5,
    })),
    clearSellerOrderCapacity: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 2,
      maxOpenOrders: null,
    })),
    scheduleSellerAwayWindow: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 1,
    })),
    cancelScheduledAwayWindow: vi.fn(async () => ({
      accountId: "acc_seller",
      version: 2,
    })),
    sweepDueSellerAwayWindowStarts: vi.fn(async () => ({
      checked: 0,
      started: 0,
      skipped: 0,
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
    getInventoryItemSupply: vi.fn(async () => null),
    getListingEvidenceCoverage: vi.fn(async () => ({
      listingId: "lst_1",
      listingStatus: "active",
      evidence: [],
      policyHash: "sha256:policy",
      policyVersion: 1,
      requirements: {
        minimumPhotoCount: 1,
        requiredSlots: [],
        sellerTrustRequirements: [],
        buyerAcknowledgment: "none",
      },
      coverage: {
        complete: false,
        unmetCodes: ["min-photo-count-unmet"],
        slots: [],
        activePhotoCount: 0,
        minimumPhotoCount: 1,
      },
      updatedAt: "2026-07-13T00:00:00.000Z",
    })),
    addListingPhotos: vi.fn(async () => ({ listingId: "lst_1", version: 3 })),
    classifyListingPhoto: vi.fn(async () => ({ listingId: "lst_1", version: 4 })),
    replaceListingPhoto: vi.fn(async () => ({ listingId: "lst_1", version: 5 })),
    applyBulkListingPriceUpdates: vi.fn(async (params: { updates: readonly { listingId: string }[] }) =>
      params.updates.map((update) => ({ listingId: update.listingId, outcome: "applied" as const, version: 2 })),
    ),
    projectors: [],
  } as unknown as MarketplaceListingServices;
}

const sellerActor: MarketplaceApiEnv["Variables"]["actor"] = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_seller",
  accountId: "acc_seller",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};

const validShipFromAddress = {
  name: "Seller shelf",
  company: null,
  line1: "100 Main St",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: null,
};

const validInventorySnapshot = {
  inventoryItemId: "inv_1",
  catalogItemId: "cat_1",
  productId: "cat_1::form:graded",
  selectedOptions: [{ dimensionId: "form", optionId: "graded" }],
  storageLocationId: "sloc_1",
  storageLocationName: "Seller shelf",
  shipFromCode: "CHI-1",
  shipFromAddress: validShipFromAddress,
  totalQuantity: 2,
  acquisitionCostAmount: "4.50",
};

describe("marketplace listing routes", () => {
  it("loads a seller-owned available inventory item by exact listing-inventory id", async () => {
    const services = createServices();
    vi.mocked(services.getInventoryItemSupply).mockResolvedValue({
      item_id: "inv_1",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::form:raw",
      item_language_code: "en",
      item_title: "Air Balloon",
      item_subtitle: null,
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Form: Raw",
      product_measure_snapshot: null,
      graded_card: null,
      storage_location_id: "sloc_1",
      storage_location_name: "Listing stock",
      ship_from_code: "CHI-1",
      ship_from_address: validShipFromAddress,
      total_quantity: 3,
      available_quantity: 3,
      acquisition_cost_amount: "4.50",
    });
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.request("/account/listing-inventory?inventoryItemId=inv_1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(services.getInventoryItemSupply).toHaveBeenCalledWith("inv_1", "acc_seller");
    expect(body).toMatchObject({
      total: 1,
      count: 1,
      items: [{ item_id: "inv_1", available_quantity: 3 }],
    });
  });

  it("does not expose exact listing-inventory items without available quantity", async () => {
    const services = createServices();
    vi.mocked(services.getInventoryItemSupply).mockResolvedValue({
      item_id: "inv_1",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::form:raw",
      item_language_code: "en",
      item_title: "Air Balloon",
      item_subtitle: null,
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Form: Raw",
      product_measure_snapshot: null,
      graded_card: null,
      storage_location_id: "sloc_1",
      storage_location_name: "Listing stock",
      ship_from_code: "CHI-1",
      ship_from_address: validShipFromAddress,
      total_quantity: 3,
      available_quantity: 0,
      acquisition_cost_amount: "4.50",
    });
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.request("/account/listing-inventory?inventoryItemId=inv_1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ total: 0, count: 0, items: [] });
  });

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

  it("rate limits public standard terms previews", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 121; index += 1) {
      response = await app.fetch(
        new Request("http://marketplace.test/terms/public-standard/listing-preview", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "203.0.113.121",
          },
          body: JSON.stringify({ priceAmount: "20.00" }),
        }),
      );
    }

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_request_rate_limited",
      },
    });
    expect(services.previewPublicStandardListingTerms).toHaveBeenCalledTimes(120);
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

  it("rate limits anonymous listing draft intent capture", async () => {
    const services = createServices();
    const app = buildApp({
      actor: null,
      services,
    });

    let response = new Response(null, { status: 500 });
    for (let index = 0; index < 31; index += 1) {
      response = await app.fetch(
        new Request("http://marketplace.test/guest/listing-draft-intents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-marketplace-anonymous-listing-draft-id": "anon_listing_draft_rate_limited",
            "x-forwarded-for": "203.0.113.122",
          },
          body: JSON.stringify({
            sourcePath: "/items/charizard?market=sell",
            catalogItemId: `cat_rate_${index}`,
            productId: `cat_rate_${index}::form:raw`,
            selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
            productSummary: "Form: Raw",
            priceAmount: "20.00",
            quantityCap: 1,
          }),
        }),
      );
    }

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "anonymous_request_rate_limited",
      },
    });
    expect(services.createAnonymousListingDraftIntent).toHaveBeenCalledTimes(30);
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
      actor: sellerActor,
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

  it("forwards status and search filters to the seller listings query and drops the all-status sentinel", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    await app.fetch(
      new Request("http://marketplace.test/account/listings?status=paused&search=Charizard&limit=25&offset=0"),
    );

    expect(services.listSellerListings).toHaveBeenCalledWith({
      accountId: "acc_seller",
      limit: 25,
      offset: 0,
      status: "paused",
      search: "Charizard",
    });

    vi.mocked(services.listSellerListings).mockClear();
    await app.fetch(new Request("http://marketplace.test/account/listings?status=all"));

    expect(services.listSellerListings).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined, search: undefined }),
    );
  });

  it("returns a stable code when listing creation cannot find Marketplace inventory supply", async () => {
    const services = createServices();
    vi.mocked(services.createListing).mockRejectedValueOnce(new Error("Inventory item not found."));
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inventoryItemId: "inv_missing_from_marketplace",
          priceAmount: "12.00",
          quantityCap: 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "inventory_item_not_found",
        message: "Inventory item not found.",
      },
    });
  });

  it("hydrates a valid inventory snapshot into seller listing creation", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          quantityCap: 1,
          inventorySnapshot: {
            ...validInventorySnapshot,
            availableQuantity: 1,
            gradedCard: {
              gradingCompany: "PSA",
              grade: "10",
              certificationNumber: "12345678",
              population: {
                populationAtGrade: 12,
                populationHigher: 0,
                source: "PSA population report",
                asOf: "2026-04-01",
              },
              conditionDescriptors: ["Gem Mint"],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(services.createListingFromInventorySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        availableQuantity: 1,
        shipFromAddress: validShipFromAddress,
        gradedCard: expect.objectContaining({
          gradingCompany: "PSA",
          grade: "10",
          conditionDescriptors: ["Gem Mint"],
        }),
      }),
      expect.any(Object),
    );
  });

  it("rejects malformed inventory snapshot ship-from addresses before creating a listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          quantityCap: 1,
          inventorySnapshot: {
            ...validInventorySnapshot,
            shipFromAddress: {
              ...validShipFromAddress,
              line1: "",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(services.createListingFromInventorySnapshot).not.toHaveBeenCalled();
    expect(services.createListing).not.toHaveBeenCalled();
  });

  it("rejects malformed inventory snapshot graded cards before creating a listing", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priceAmount: "12.00",
          quantityCap: 1,
          inventorySnapshot: {
            ...validInventorySnapshot,
            gradedCard: {
              gradingCompany: "PSA",
              certificationNumber: "12345678",
              population: null,
              conditionDescriptors: [],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(services.createListingFromInventorySnapshot).not.toHaveBeenCalled();
    expect(services.createListing).not.toHaveBeenCalled();
  });

  it("publishes a seller listing through the documented API action", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
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

  it("exposes seller-scoped evidence coverage and classification actions", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const coverageResponse = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/evidence-coverage?now=2026-07-13T00:00:00.000Z"),
    );
    expect(coverageResponse.status).toBe(200);
    await expect(coverageResponse.json()).resolves.toMatchObject({
      listingId: "lst_1",
      coverage: { complete: false, unmetCodes: ["min-photo-count-unmet"] },
    });
    expect(services.getListingEvidenceCoverage).toHaveBeenCalledWith({
      accountId: "acc_seller",
      listingId: "lst_1",
      now: "2026-07-13T00:00:00.000Z",
    });

    const classifyResponse = await app.fetch(
      new Request("http://marketplace.test/account/listings/lst_1/photos/lpho_1/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId: "front", viewKind: "front" }),
      }),
    );
    expect(classifyResponse.status).toBe(200);
    expect(services.classifyListingPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        listingId: "lst_1",
        photoId: "lpho_1",
        slotId: "front",
        viewKind: "front",
      }),
      expect.anything(),
    );
  });

  it("applies a batch of listing price updates through the bulk price-update route (m113 #4327)", async () => {
    const services = createServices();
    const app = buildApp({
      actor: sellerActor,
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/listings/prices/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [
            { listingId: "lst_1", priceAmount: "21.00" },
            { listingId: "lst_2", priceAmount: "22.00", feeQuoteFingerprint: "some-fingerprint" },
            { listingId: "" },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        { listingId: "lst_1", outcome: "applied", version: 2 },
        { listingId: "lst_2", outcome: "applied", version: 2 },
      ],
      total: 2,
      count: 2,
    });
    // The empty listingId entry is dropped before it ever reaches the
    // service -- callers cannot request an update for no listing.
    expect(services.applyBulkListingPriceUpdates).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        updates: [
          { listingId: "lst_1", priceAmount: "21.00", feeQuoteFingerprint: null },
          { listingId: "lst_2", priceAmount: "22.00", feeQuoteFingerprint: "some-fingerprint" },
        ],
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
        availableAgainAt: null,
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("forwards the client-captured authoritative resume instant when disabling seller listing availability", async () => {
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
          reasonCategory: "travel",
          availableAgainOn: "2026-07-20",
          availableAgainAt: "2026-07-20T05:00:00.000Z",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(services.disableSellerListingAvailability).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        reasonCategory: "travel",
        availableAgainOn: "2026-07-20",
        availableAgainAt: "2026-07-20T05:00:00.000Z",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("reads seller order capacity for the acting account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.request("/account/order-capacity");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(services.getSellerOrderCapacity).toHaveBeenCalledWith("acc_seller");
    expect(body).toEqual({
      account_id: "acc_seller",
      max_open_orders: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("sets seller order capacity for the acting account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "POST",
        body: JSON.stringify({ maxOpenOrders: 5 }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 1,
      maxOpenOrders: 5,
    });
    expect(services.setSellerOrderCapacity).toHaveBeenCalledWith(
      { accountId: "acc_seller", maxOpenOrders: 5 },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("rejects setting seller order capacity below 1", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "POST",
        body: JSON.stringify({ maxOpenOrders: 0 }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(services.setSellerOrderCapacity).not.toHaveBeenCalled();
  });

  it("clears seller order capacity for the acting account", async () => {
    const services = createServices();
    const app = buildApp({ actor: sellerActor, services });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 2,
      maxOpenOrders: null,
    });
    expect(services.clearSellerOrderCapacity).toHaveBeenCalledWith(
      { accountId: "acc_seller" },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("requires listings.manage permission to set seller order capacity", async () => {
    const services = createServices();
    const app = buildApp({
      actor: {
        sessionId: "ses_1",
        tenantId: "tnt_identity",
        userId: "usr_seller",
        accountId: "acc_seller",
        membershipId: "mbr_1",
        roleKey: "viewer",
        permissions: ["listings.view"],
      },
      services,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/account/order-capacity", {
        method: "POST",
        body: JSON.stringify({ maxOpenOrders: 5 }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(403);
    expect(services.setSellerOrderCapacity).not.toHaveBeenCalled();
  });

  it("schedules an away window for the acting account", async () => {
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
      new Request("http://marketplace.test/account/listing-availability/away-window", {
        method: "POST",
        body: JSON.stringify({
          reasonCategory: "travel",
          startsAt: "2026-07-20T05:00:00.000Z",
          endsAt: "2026-07-27T05:00:00.000Z",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 1,
    });
    expect(services.scheduleSellerAwayWindow).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        reasonCategory: "travel",
        startsAt: "2026-07-20T05:00:00.000Z",
        endsAt: "2026-07-27T05:00:00.000Z",
      },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });

  it("rejects scheduling an away window without a reason", async () => {
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
      new Request("http://marketplace.test/account/listing-availability/away-window", {
        method: "POST",
        body: JSON.stringify({
          startsAt: "2026-07-20T05:00:00.000Z",
          endsAt: null,
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(services.scheduleSellerAwayWindow).not.toHaveBeenCalled();
  });

  it("cancels the scheduled away window for the acting account", async () => {
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
      new Request("http://marketplace.test/account/listing-availability/away-window", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_seller",
      version: 2,
    });
    expect(services.cancelScheduledAwayWindow).toHaveBeenCalledWith(
      { accountId: "acc_seller" },
      expect.objectContaining({
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
          performedByUserId: "usr_seller",
        }),
      }),
    );
  });
});
