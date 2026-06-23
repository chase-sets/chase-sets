import { describe, expect, it, vi } from "vitest";
import { action as listingsAction, loader as listingsLoader } from "../routes/account-listings";
import {
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeCommitReceipt,
  readFreshWriteToken,
} from "@chase-sets/http/responses";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const sellerActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};

const listingAvailability = {
  account_id: "acc_1",
  status: "available",
  disabled_reason_category: null,
  available_again_on: null,
  disabled_at: null,
  enabled_at: null,
  updated_at: "2026-04-17T00:00:00.000Z",
};

const shipFromAddress = {
  name: "Seller",
  line1: "100 Market St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

const inventoryItemDetail = {
  item_id: "inv_1",
  account_id: "acc_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::dim_condition:near_mint",
  language_code: "en",
  item_title: "Charizard ex",
  item_subtitle: null,
  selected_options: [{ dimensionId: "dim_condition", optionId: "near_mint" }],
  product_summary: "Condition: Near Mint",
  graded_card: null,
  storage_location_id: "loc_1",
  storage_location_name: "North shelf",
  ship_from_code: "CHI-WH-1",
  ship_from_address: shipFromAddress,
  total_quantity: 7,
  held_quantity: 0,
  available_quantity: 7,
  acquisition_cost_amount: "1.00",
  created_at: "2026-04-17T00:00:00.000Z",
  updated_at: "2026-04-17T00:00:00.000Z",
  holds: [],
};

describe("marketplace listing routes", () => {
  it("preselects inventory when the seller enters from an inventory item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/marketplace/account/listing-inventory")) {
          return Promise.resolve(
            jsonResponse({
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
            }),
          );
        }

        if (url.includes("/api/marketplace/account/supply-locations/exists")) {
          return Promise.resolve(jsonResponse({ exists: false }));
        }

        if (url.includes("/api/marketplace/account/listing-availability")) {
          return Promise.resolve(jsonResponse(listingAvailability));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsLoader({
      request: new Request("http://localhost/account/listings?inventoryItemId=inv_1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.createForm?.inventoryItemId).toBe("inv_1");
    expect(result.createForm?.quantityCap).toBe("1");
    expect(result.inventoryItems).toHaveLength(1);
  });

  it("forwards inventory freshness when preselecting newly-created inventory", async () => {
    const inventoryHeaders: Headers[] = [];
    const freshPath = appendFreshWriteToken(
      "/account/listings?inventoryItemId=inv_1",
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

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/marketplace/account/listing-inventory")) {
          inventoryHeaders.push(new Headers(init?.headers));
          return Promise.resolve(
            jsonResponse({
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
            }),
          );
        }

        if (url.includes("/api/marketplace/account/supply-locations/exists")) {
          return Promise.resolve(jsonResponse({ exists: true }));
        }

        if (url.includes("/api/marketplace/account/listing-availability")) {
          return Promise.resolve(jsonResponse(listingAvailability));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsLoader({
      request: new Request(`http://localhost${freshPath}`),
      params: {},
      context: undefined,
    } as never);

    expect(result.createForm?.inventoryItemId).toBe("inv_1");
    expect(inventoryHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(inventoryHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });

  it("preselects requested inventory through exact lookup when the first inventory page is empty", async () => {
    const listingInventoryUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/marketplace/account/listing-inventory")) {
          listingInventoryUrls.push(url);
          if (url.includes("inventoryItemId=inv_1")) {
            return Promise.resolve(
              jsonResponse({
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
              }),
            );
          }

          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        if (url.includes("/api/marketplace/account/supply-locations/exists")) {
          return Promise.resolve(jsonResponse({ exists: true }));
        }

        if (url.includes("/api/marketplace/account/listing-availability")) {
          return Promise.resolve(jsonResponse(listingAvailability));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsLoader({
      request: new Request("http://localhost/account/listings?inventoryItemId=inv_1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.createForm?.inventoryItemId).toBe("inv_1");
    expect(result.inventoryItems).toHaveLength(1);
    expect(listingInventoryUrls.some((url) => url.includes("inventoryItemId=inv_1"))).toBe(true);
  });

  it("preselects an explicit Inventory handoff item when the Marketplace supply mirror is missing it", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/marketplace/account/listing-inventory")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        if (url.includes("/api/inventory/items/inv_1")) {
          return Promise.resolve(jsonResponse(inventoryItemDetail));
        }

        if (url.includes("/api/marketplace/account/supply-locations/exists")) {
          return Promise.resolve(jsonResponse({ exists: true }));
        }

        if (url.includes("/api/marketplace/account/listing-availability")) {
          return Promise.resolve(jsonResponse(listingAvailability));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsLoader({
      request: new Request("http://localhost/account/listings?inventoryItemId=inv_1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.createForm?.inventoryItemId).toBe("inv_1");
    expect(result.inventoryItems).toEqual([
      expect.objectContaining({
        item_id: "inv_1",
        storage_location_name: "North shelf",
        available_quantity: 7,
      }),
    ]);
    expect(requestedUrls.some((url) => url.includes("/api/inventory/items/inv_1"))).toBe(true);
  });

  it("creates and publishes a listing in one seller action", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("/api/auth/session")) {
        return Promise.resolve(jsonResponse({ actor: sellerActor }));
      }

      if (url.includes("/api/marketplace/account/listings/lst_1/publish")) {
        return Promise.resolve(
          jsonResponse({ id: "lst_1", version: 2 }, 200, {
            "Chase-Sets-Consistency": "eventual",
            [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
              {
                sourceContextName: "marketplace",
                maxGlobalPosition: "42",
                eventIds: ["evt_listing_published"],
              },
            ]),
          }),
        );
      }

      return Promise.resolve(
        jsonResponse({ id: "lst_1", version: 1 }, 201, {
          "Chase-Sets-Consistency": "eventual",
          [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
            {
              sourceContextName: "marketplace",
              maxGlobalPosition: "41",
              eventIds: ["evt_listing_created"],
            },
          ]),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const form = new URLSearchParams();
    form.set("intent", "create-and-publish-listing");
    form.set("inventoryItemId", "inv_1");
    form.set("priceAmount", "24.99");
    form.set("quantityCap", "1");

    const result = await listingsAction({
      request: new Request("http://localhost/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    const location = (result as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/listings\/lst_1\?feedbackWorkflow=listing-publish&afterWrite=/);
    expect(readFreshWriteToken(location)?.sources).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: expect.arrayContaining(["evt_listing_created", "evt_listing_published"]),
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/marketplace/account/listings/lst_1/publish"),
      expect.any(Object),
    );
  });

  it("carries write consistency metadata into create redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        return Promise.resolve(
          jsonResponse({ id: "lst_1", version: 1 }, 201, {
            "Chase-Sets-Consistency": "eventual",
            "Chase-Sets-Commit-Position": "42",
          }),
        );
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-listing");
    form.set("inventoryItemId", "inv_1");
    form.set("priceAmount", "24.99");
    form.set("quantityCap", "1");

    const result = await listingsAction({
      request: new Request("http://localhost/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    const location = (result as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/listings\/lst_1\?afterWrite=/);
    expect(readFreshWriteToken(location)?.commitPosition).toBe("42");
  });

  it("creates a listing from an Inventory snapshot when the Marketplace mirror is missing the selected item", async () => {
    const marketplaceCreateBodies: Record<string, unknown>[] = [];
    let marketplaceCreateAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return jsonResponse({ actor: sellerActor });
        }

        if (url.includes("/api/inventory/items/inv_1")) {
          return jsonResponse(inventoryItemDetail);
        }

        if (url.includes("/api/marketplace/account/listings")) {
          marketplaceCreateAttempts += 1;
          marketplaceCreateBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);

          if (marketplaceCreateAttempts === 1) {
            return jsonResponse(
              { error: { code: "inventory_item_not_found", message: "Inventory item not found." } },
              400,
            );
          }

          return jsonResponse({ id: "lst_1", version: 1 }, 201, {
            "Chase-Sets-Consistency": "eventual",
            [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
              {
                sourceContextName: "marketplace",
                maxGlobalPosition: "41",
                eventIds: ["evt_listing_created"],
              },
            ]),
          });
        }

        return jsonResponse({ items: [], total: 0, count: 0 });
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-listing");
    form.set("inventoryItemId", "inv_1");
    form.set("priceAmount", "24.99");
    form.set("quantityCap", "1");

    const result = await listingsAction({
      request: new Request("http://localhost/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toMatch(/^\/account\/listings\/lst_1\?afterWrite=/);
    expect(marketplaceCreateBodies).toHaveLength(2);
    expect(marketplaceCreateBodies[1]).toMatchObject({
      inventoryItemId: "inv_1",
      inventorySnapshot: {
        inventoryItemId: "inv_1",
        storageLocationId: "loc_1",
        totalQuantity: 7,
        availableQuantity: 7,
      },
    });
  });

  it("marks seller availability disable redirects with the pending availability action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        return Promise.resolve(
          jsonResponse({ accountId: "acc_1", version: 2, status: "unavailable" }, 200, {
            "Chase-Sets-Consistency": "eventual",
            "Chase-Sets-Commit-Position": "43",
          }),
        );
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "disable-listing-availability");
    form.set("reasonCategory", "operations");

    const result = await listingsAction({
      request: new Request("http://localhost/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    const location = (result as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/listings\?availabilityAction=disabled&afterWrite=/);
    expect(readFreshWriteToken(location)?.commitPosition).toBe("43");
  });

  it("forwards afterWrite metadata when refreshing listing availability", async () => {
    const availabilityHeaders: Headers[] = [];
    const freshPath = appendFreshWriteToken(
      "/account/listings",
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "43",
            eventIds: ["evt_listing_availability"],
          },
        ],
        commitEventIds: ["evt_listing_availability"],
      },
      Date.now(),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/marketplace/account/listing-availability")) {
          availabilityHeaders.push(new Headers(init?.headers));
          return Promise.resolve(
            jsonResponse({
              ...listingAvailability,
              status: "unavailable",
              disabled_reason_category: "audit",
              updated_at: "2026-04-18T00:00:00.000Z",
            }),
          );
        }

        if (url.includes("/api/marketplace/account/supply-locations/exists")) {
          return Promise.resolve(jsonResponse({ exists: true }));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsLoader({
      request: new Request(`http://localhost${freshPath}`),
      params: {},
      context: undefined,
    } as never);

    expect(result.listingAvailability.status).toBe("unavailable");
    expect(availabilityHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(availabilityHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });
});
