import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireActorFromAuthApi,
  mockResolveRequiredActorFromAuthApi,
  mockCreateMarketplaceRequestApiClient,
  mockCreateInventoryRequestApiClient,
  mockClaimAnonymousListingDraftIntent,
} = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
  mockResolveRequiredActorFromAuthApi: vi.fn(),
  mockCreateMarketplaceRequestApiClient: vi.fn(),
  mockCreateInventoryRequestApiClient: vi.fn(),
  mockClaimAnonymousListingDraftIntent: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
    resolveRequiredActorFromAuthApi: mockResolveRequiredActorFromAuthApi,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  MarketplaceApiError: class MarketplaceApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${status}`);
    }
  },
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
}));

vi.mock("@chase-sets/inventory/server", () => ({
  createInventoryRequestApiClient: mockCreateInventoryRequestApiClient,
}));

import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { MarketplaceApiError } from "../support/request-support/api-client";
import { loader } from "../routes/account-listings";

describe("account listings route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an account access state instead of throwing 403 for signed-in actors without listing access", async () => {
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "forbidden",
      actor: {
        accountId: "acc_platform",
        permissions: ["accounts.view"],
      },
      requiredPermission: "listings.view",
    });
    const listSellerListings = vi.fn();
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings,
    });

    const result = await loader({
      request: new Request("http://localhost/account/listings"),
      params: {},
      context: {},
    } as never);

    expect(result).toMatchObject({
      accountAccessRequired: {
        returnTo: "/account/listings",
      },
    });
    expect(listSellerListings).not.toHaveBeenCalled();
  });

  it("claims an anonymous listing draft intent and pre-fills the create listing form", async () => {
    const listSellerListings = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockClaimAnonymousListingDraftIntent.mockResolvedValue({
      intent_id: "ldi_1",
      anonymous_owner_id: "anon_listing_draft",
      source_path: "/items/charizard?market=sell",
      catalog_item_id: "cat_charizard",
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Form: Raw",
      price_amount: "350.00",
      quantity_cap: 2,
      max_units_per_order: 1,
      max_units_per_day: null,
      max_units_per_customer_account: null,
      status: "claimed",
      claimed_account_id: "acc_seller",
      claimed_at: "2026-04-17T00:00:00.000Z",
      expires_at: "2026-05-17T00:00:00.000Z",
      created_at: "2026-04-17T00:00:00.000Z",
      updated_at: "2026-04-17T00:00:00.000Z",
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings,
      listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSellerListingInventory: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      hasSellerSupplyLocationNamed: vi.fn().mockResolvedValue(false),
      claimAnonymousListingDraftIntent: mockClaimAnonymousListingDraftIntent,
      getSellerListingAvailability: vi.fn().mockResolvedValue({
        account_id: "acc_seller",
        status: "available",
        disabled_reason_category: null,
        available_again_on: null,
        disabled_at: null,
        enabled_at: null,
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/account/listings?claimListingIntent=ldi_1", {
        headers: {
          cookie: "chase_sets_anonymous_listing_drafts=anon_listing_draft",
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(mockClaimAnonymousListingDraftIntent).toHaveBeenCalledWith("anon_listing_draft", "ldi_1");
    expect(mockClaimAnonymousListingDraftIntent.mock.invocationCallOrder[0]).toBeLessThan(
      listSellerListings.mock.invocationCallOrder[0]!,
    );
    expect(result.claimError).toBeNull();
    expect(result.createForm).toEqual({
      inventoryItemId: "",
      catalogItemId: "cat_charizard",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      priceAmount: "350.00",
      quantityCap: "2",
      maxUnitsPerOrder: "1",
      maxUnitsPerDay: "",
      maxUnitsPerCustomerAccount: "",
    });
  });

  it("keeps the claimed draft form when fresh seller page reads are still catching up", async () => {
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockClaimAnonymousListingDraftIntent.mockResolvedValue({
      intent_id: "ldi_1",
      anonymous_owner_id: "anon_listing_draft",
      source_path: "/items/charizard?market=sell",
      catalog_item_id: "cat_charizard",
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Form: Raw",
      price_amount: "350.00",
      quantity_cap: 2,
      max_units_per_order: 1,
      max_units_per_day: null,
      max_units_per_customer_account: null,
      status: "claimed",
      claimed_account_id: "acc_seller",
      claimed_at: "2026-04-17T00:00:00.000Z",
      expires_at: "2026-05-17T00:00:00.000Z",
      created_at: "2026-04-17T00:00:00.000Z",
      updated_at: "2026-04-17T00:00:00.000Z",
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings: vi.fn().mockRejectedValue(
        new MarketplaceApiError(503, {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection freshness timed out.",
          },
        }),
      ),
      listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSellerListingInventory: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      hasSellerSupplyLocationNamed: vi.fn().mockResolvedValue(false),
      claimAnonymousListingDraftIntent: mockClaimAnonymousListingDraftIntent,
      getSellerListingAvailability: vi.fn().mockResolvedValue({
        account_id: "acc_seller",
        status: "available",
        disabled_reason_category: null,
        available_again_on: null,
        disabled_at: null,
        enabled_at: null,
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({});
    const path = appendFreshWriteToken("/account/listings?claimListingIntent=ldi_1", {
      commitPositions: [
        {
          sourceContextName: "identity",
          maxGlobalPosition: "51",
          eventIds: ["evt_identity_51"],
        },
      ],
      commitEventIds: ["evt_identity_51"],
    });

    const result = await loader({
      request: new Request(`http://localhost${path}`, {
        headers: {
          cookie: "chase_sets_anonymous_listing_drafts=anon_listing_draft",
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(result.listings).toEqual({
      items: [],
      total: 0,
      count: 0,
      limit: 100,
      offset: 0,
      statusCounts: { active: 0, draft: 0, paused: 0, withdrawn: 0 },
    });
    expect(result.inventoryItems).toEqual([]);
    expect(result.listingAvailability.account_id).toBe("acc_seller");
    expect(result.claimError).toBeNull();
    expect(result.createForm?.catalogItemId).toBe("cat_charizard");
    expect(result.createForm?.priceAmount).toBe("350.00");
  });

  it("renders temporary seller availability state for marketplace availability fresh-write timeouts", async () => {
    const projectionTimeout = new MarketplaceApiError(503, {
      error: {
        code: "projection_freshness_timeout",
        message: "Projection freshness timed out.",
      },
    });
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSellerListingInventory: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      hasSellerSupplyLocationNamed: vi.fn().mockResolvedValue(false),
      getSellerListingAvailability: vi.fn().mockRejectedValue(projectionTimeout),
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({});
    const path = appendFreshWriteToken("/account/listings?availabilityAction=disabled", {
      commitPositions: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "52",
          eventIds: ["evt_marketplace_52"],
        },
      ],
      commitEventIds: ["evt_marketplace_52"],
    });

    const result = await loader({
      request: new Request(`http://localhost${path}`),
      params: {},
      context: {},
    } as never);

    expect(result.listingAvailability).toMatchObject({
      account_id: "acc_seller",
      status: "unavailable",
    });
    expect(result.listings).toEqual({
      items: [],
      total: 0,
      count: 0,
      limit: 100,
      offset: 0,
      statusCounts: { active: 0, draft: 0, paused: 0, withdrawn: 0 },
    });
  });

  it("pre-fills selected product options from listing setup links", async () => {
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listSellerListingInventory: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      hasSellerSupplyLocationNamed: vi.fn().mockResolvedValue(false),
      getSellerListingAvailability: vi.fn().mockResolvedValue({
        account_id: "acc_seller",
        status: "available",
        disabled_reason_category: null,
        available_again_on: null,
        disabled_at: null,
        enabled_at: null,
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({});
    const selectedOptions = encodeURIComponent(JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]));

    const result = await loader({
      request: new Request(
        `http://localhost/account/listings?catalogItemId=cat_charizard&recommendedPrice=350.00&selectedOptions=${selectedOptions}`,
      ),
      params: {},
      context: {},
    } as never);

    expect(result.createForm).toEqual({
      inventoryItemId: "",
      catalogItemId: "cat_charizard",
      selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
      priceAmount: "350.00",
      quantityCap: "1",
      maxUnitsPerOrder: "",
      maxUnitsPerDay: "",
      maxUnitsPerCustomerAccount: "",
    });
  });
});
