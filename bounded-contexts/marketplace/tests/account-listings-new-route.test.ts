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
import { loader } from "../routes/account-listings-new";

describe("account listings new route", () => {
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
    const listSellerListingInventory = vi.fn();
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListingInventory,
    });

    const result = await loader({
      request: new Request("http://localhost/account/listings/new"),
      params: {},
      context: {},
    } as never);

    expect(result).toMatchObject({
      accountAccessRequired: {
        returnTo: "/account/listings/new",
      },
    });
    expect(listSellerListingInventory).not.toHaveBeenCalled();
  });

  it("claims an anonymous listing draft intent and pre-fills the create listing form", async () => {
    const listSellerListingInventory = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
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
      listSellerListingInventory,
      hasSellerSupplyLocationNamed: vi.fn().mockResolvedValue(false),
      claimAnonymousListingDraftIntent: mockClaimAnonymousListingDraftIntent,
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/account/listings/new?claimListingIntent=ldi_1", {
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

  it("forwards inventory freshness when preselecting newly-created inventory", async () => {
    const inventoryHeaders: Headers[] = [];
    const freshPath = appendFreshWriteToken(
      "/account/listings/new?inventoryItemId=inv_1",
      {
        commitPositions: [
          {
            sourceContextName: "inventory",
            maxGlobalPosition: "61",
            eventIds: ["evt_inventory_61"],
          },
        ],
        commitEventIds: ["evt_inventory_61"],
      },
      Date.now(),
    );
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListingInventory: vi.fn((query: string) => {
        inventoryHeaders.push(new Headers({ query }));
        return Promise.resolve({
          items: [
            {
              item_id: "inv_1",
              account_id: "acc_1",
              catalog_catalog_item_id: "cat_charizard",
              product_id: "cat_charizard::dim_condition:near_mint",
              item_title: "Charizard ex",
              item_subtitle: null,
              selected_options: [{ dimensionId: "dim_condition", optionId: "near_mint" }],
              product_summary: "Condition: Near Mint",
              product_measure_snapshot: null,
              graded_card: null,
              storage_location_name: "North shelf",
              ship_from_code: "CHI-WH-1",
              ship_from_address: {
                name: "Seller",
                line1: "100 Market St",
                city: "Chicago",
                state: "IL",
                postalCode: "60601",
                country: "US",
              },
              available_quantity: 7,
            },
          ],
          total: 1,
          count: 1,
        });
      }),
      hasSellerSupplyLocationNamed: vi.fn().mockResolvedValue(true),
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request(`http://localhost${freshPath}`),
      params: {},
      context: undefined,
    } as never);

    expect(result.createForm?.inventoryItemId).toBe("inv_1");
    expect(result.inventoryItems).toHaveLength(1);
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
      listSellerListingInventory: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      hasSellerSupplyLocationNamed: vi.fn().mockResolvedValue(false),
    });
    mockCreateInventoryRequestApiClient.mockReturnValue({});
    const selectedOptions = encodeURIComponent(JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]));

    const result = await loader({
      request: new Request(
        `http://localhost/account/listings/new?catalogItemId=cat_charizard&recommendedPrice=350.00&selectedOptions=${selectedOptions}`,
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
