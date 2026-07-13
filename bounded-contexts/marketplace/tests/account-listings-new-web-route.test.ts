import { afterEach, describe, expect, it, vi } from "vitest";
import { action as listingsNewAction, loader as listingsNewLoader } from "../routes/account-listings-new";
import {
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeCommitReceipt,
  readCompactPostWriteToken,
  type PostWriteTokenPayload,
} from "@chase-sets/http/responses";
import { configureMarketplacePostWriteTokenStoreForTests } from "../support/route-support/post-write-tokens";

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

const shipFromAddress = {
  name: "Seller",
  line1: "100 Market St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

const listingInventoryItem = {
  item_id: "inv_1",
  account_id: "acc_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::dim_condition:near_mint",
  item_language_code: "en",
  item_title: "Charizard ex",
  item_subtitle: null,
  selected_options: [{ dimensionId: "dim_condition", optionId: "near_mint" }],
  product_summary: "Condition: Near Mint",
  product_measure_snapshot: null,
  graded_card: null,
  storage_location_id: "loc_1",
  storage_location_name: "North shelf",
  ship_from_code: "CHI-WH-1",
  ship_from_address: shipFromAddress,
  total_quantity: 7,
  available_quantity: 7,
  acquisition_cost_amount: "1.00",
};

let restorePostWriteTokenStore: (() => void) | null = null;

afterEach(() => {
  restorePostWriteTokenStore?.();
  restorePostWriteTokenStore = null;
  vi.unstubAllGlobals();
});

function createTestPostWriteTokenStore() {
  const payloads = new Map<string, PostWriteTokenPayload>();
  const storeCalls: Array<Readonly<{ payload: PostWriteTokenPayload; nowMs: number; ttlMs: number }>> = [];
  let nextToken = 1;

  return {
    storeCalls,
    seed(token: string, payload: PostWriteTokenPayload) {
      payloads.set(token, payload);
    },
    async storePostWriteToken(payload: PostWriteTokenPayload, options: Readonly<{ nowMs: number; ttlMs: number }>) {
      const token = `pwt_listings${String(nextToken++).padStart(15, "0")}`;
      payloads.set(token, payload);
      storeCalls.push({ payload, ...options });
      return token;
    },
    async resolvePostWriteToken(token: string) {
      return payloads.get(token) ?? null;
    },
  };
}

describe("marketplace listing create route", () => {
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
                  ship_from_address: shipFromAddress,
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

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsNewLoader({
      request: new Request("http://localhost/account/listings/new?inventoryItemId=inv_1"),
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
                  ship_from_address: shipFromAddress,
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

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsNewLoader({
      request: new Request(`http://localhost${freshPath}`),
      params: {},
      context: undefined,
    } as never);

    expect(result.createForm?.inventoryItemId).toBe("inv_1");
    expect(inventoryHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(inventoryHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });

  it("does not fall back to Inventory when an explicit handoff item is missing from Marketplace supply", async () => {
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
          throw new Error("Inventory reads are not allowed from account listings.");
        }

        if (url.includes("/api/marketplace/account/supply-locations/exists")) {
          return Promise.resolve(jsonResponse({ exists: true }));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsNewLoader({
      request: new Request("http://localhost/account/listings/new?inventoryItemId=inv_1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.createForm).toBeNull();
    expect(result.inventoryItems).toEqual([]);
    expect(result.claimError).toBe(
      "That inventory item is still preparing for listing setup. Refresh this page in a moment and the selected stock should appear.",
    );
    expect(requestedUrls.some((url) => url.includes("/api/inventory/items/inv_1"))).toBe(false);
  });

  it("creates and publishes a listing in one seller action", async () => {
    const store = createTestPostWriteTokenStore();
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
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

    const result = await listingsNewAction({
      request: new Request("http://localhost/account/listings/new", {
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
    expect(location).toMatch(/^\/account\/listings\/lst_1\?postWriteToken=/);
    expect(readCompactPostWriteToken(location)).toMatch(/^pwt_listings/);
    expect(location).not.toContain("afterWrite=");
    expect(location).not.toContain("evt_listing_created");
    expect(location).not.toContain("evt_listing_published");
    expect(store.storeCalls[0]?.payload.receipt.sources).toEqual([
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
    const store = createTestPostWriteTokenStore();
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
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

    const result = await listingsNewAction({
      request: new Request("http://localhost/account/listings/new", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    const location = (result as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/listings\/lst_1\?postWriteToken=/);
    expect(readCompactPostWriteToken(location)).toMatch(/^pwt_listings/);
    expect(location).not.toContain("afterWrite=");
    expect(store.storeCalls[0]?.payload.receipt.commitPosition).toBe("42");
  });

  it("creates a listing from a Marketplace supply snapshot when direct create misses the selected item", async () => {
    const store = createTestPostWriteTokenStore();
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
    const marketplaceCreateBodies: Record<string, unknown>[] = [];
    let marketplaceCreateAttempts = 0;
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes("/api/auth/session")) {
          return jsonResponse({ actor: sellerActor });
        }

        if (url.includes("/api/inventory/items/inv_1")) {
          throw new Error("Inventory reads are not allowed from account listings.");
        }

        if (url.includes("/api/marketplace/account/listing-inventory")) {
          return jsonResponse({ items: [listingInventoryItem], total: 1, count: 1 });
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

    const result = await listingsNewAction({
      request: new Request("http://localhost/account/listings/new", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toMatch(/^\/account\/listings\/lst_1\?postWriteToken=/);
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
    expect(requestedUrls.some((url) => url.includes("/api/inventory/items/inv_1"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/api/marketplace/account/listing-inventory"))).toBe(true);
  });

  it("returns a preparing error when create recovery cannot find the selected Marketplace supply item", async () => {
    const marketplaceCreateBodies: Record<string, unknown>[] = [];
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes("/api/auth/session")) {
          return jsonResponse({ actor: sellerActor });
        }

        if (url.includes("/api/inventory/items/inv_1")) {
          throw new Error("Inventory reads are not allowed from account listings.");
        }

        if (url.includes("/api/marketplace/account/listing-inventory")) {
          return jsonResponse({ items: [], total: 0, count: 0 });
        }

        if (url.includes("/api/marketplace/account/listings")) {
          marketplaceCreateBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return jsonResponse(
            { error: { code: "inventory_item_not_found", message: "Inventory item not found." } },
            400,
          );
        }

        return jsonResponse({ items: [], total: 0, count: 0 });
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-listing");
    form.set("inventoryItemId", "inv_1");
    form.set("priceAmount", "24.99");
    form.set("quantityCap", "1");

    const result = await listingsNewAction({
      request: new Request("http://localhost/account/listings/new", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      createForm: { inventoryItemId: "inv_1" },
      error:
        "That inventory item is still preparing for listing setup. Refresh this page in a moment and the selected stock should appear.",
    });
    expect(marketplaceCreateBodies).toHaveLength(1);
    expect(requestedUrls.some((url) => url.includes("/api/inventory/items/inv_1"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/api/marketplace/account/listing-inventory"))).toBe(true);
  });
});
