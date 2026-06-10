import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireActorFromAuthApi,
  mockCreateMarketplaceRequestApiClient,
  mockCreateInventoryRequestApiClient,
  mockClaimAnonymousListingDraftIntent,
} = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
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
  };
});

vi.mock("../support/request-support/api-client", () => ({
  MarketplaceApiError: class MarketplaceApiError extends Error {},
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
}));

vi.mock("@chase-sets/inventory/server", () => ({
  createInventoryRequestApiClient: mockCreateInventoryRequestApiClient,
}));

import { loader } from "../routes/account-listings";

describe("account listings route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("claims an anonymous listing draft intent and pre-fills the create listing form", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.view", "listings.manage"],
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
      listSellerListings: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0 }),
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
    mockCreateInventoryRequestApiClient.mockReturnValue({
      listItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listStorageLocations: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    });

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
});
