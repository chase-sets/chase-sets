import { describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  encodeCommitReceipt,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { action as inventoryAction, loader as inventoryLoader } from "../routes/marketplace/account-inventory";
import {
  action as inventoryImportsAction,
  loader as inventoryImportsLoader,
} from "../routes/marketplace/account-inventory-imports";
import {
  action as inventoryItemAction,
  loader as inventoryItemLoader,
} from "../routes/marketplace/account-inventory-item";
import {
  action as inventoryLocationsAction,
  loader as inventoryLocationsLoader,
} from "../routes/marketplace/account-inventory-locations";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function inventoryCommit(position = "42") {
  return {
    commandReceipt: {
      mode: "eventual",
      commitPosition: position,
      commitEventIds: [`evt_inventory_${position}`],
      commitPositions: [
        {
          sourceContextName: "inventory",
          maxGlobalPosition: position,
          eventIds: [`evt_inventory_${position}`],
        },
      ],
    },
  };
}

function commitHeaders(position = "42") {
  return {
    "Chase-Sets-Consistency": "eventual",
    "Chase-Sets-Commit-Position": position,
    "Chase-Sets-Commit-Event-Ids": `evt_inventory_${position}`,
    "Chase-Sets-Commit-Receipt": encodeCommitReceipt([
      {
        sourceContextName: "inventory",
        maxGlobalPosition: position,
        eventIds: [`evt_inventory_${position}`],
      },
    ]),
  };
}

describe("marketplace inventory routes", () => {
  it("loads inventory items and locations through the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await inventoryLoader({
      request: new Request("http://localhost/account/inventory"),
      params: {},
      context: undefined,
    } as never);

    expect(result.items.items).toEqual([]);
    expect(result.locations.items).toEqual([]);
  });

  it("keeps the account inventory route loadable when item reads fail temporarily", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "query_wait_timeout",
                message: "Inventory list query waited too long for a database connection.",
              },
            },
            500,
          ),
        );
      }),
    );

    const result = await inventoryLoader({
      request: new Request("http://localhost/account/inventory"),
      params: {},
      context: undefined,
    } as never);

    expect(result.items.items).toEqual([]);
    expect(result.locations.items).toEqual([]);
    expect(result.loadError).toBe("Inventory items are taking longer than expected. Reload this page in a moment.");
  });

  it("bounds the account inventory item read before the route load budget is exhausted", async () => {
    vi.useFakeTimers();
    const itemReadSignals: AbortSignal[] = [];

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);

          if (url.includes("/api/auth/session")) {
            return Promise.resolve(
              jsonResponse({
                actor: {
                  sessionId: "ses_1",
                  tenantId: "tnt_identity",
                  userId: "usr_1",
                  accountId: "acc_1",
                  membershipId: "mbr_1",
                  roleKey: "owner",
                  permissions: ["inventory.view", "inventory.manage"],
                },
              }),
            );
          }

          if (url.includes("/api/inventory/storage-locations")) {
            return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
          }

          if (init?.signal) {
            itemReadSignals.push(init.signal);
          }
          return new Promise<Response>(() => undefined);
        }),
      );

      const resultPromise = inventoryLoader({
        request: new Request("http://localhost/account/inventory"),
        params: {},
        context: undefined,
      } as never);

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.items.items).toEqual([]);
      expect(result.locations.items).toEqual([]);
      expect(result.loadError).toBe("Inventory items are taking longer than expected. Reload this page in a moment.");
      expect(itemReadSignals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads Sell List inventory create draft from safe query parameters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const selectedOptions = encodeURIComponent(JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]));
    const result = await inventoryLoader({
      request: new Request(
        `http://localhost/account/inventory?catalogItemId=cat_1&selectedOptions=${selectedOptions}&returnTo=%2Faccount%2Fsell-list`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.createItemDraft).toEqual({
      catalogItemId: "cat_1",
      selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
      returnTo: "/account/sell-list",
    });
  });

  it("returns action errors from the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ error: "Bad inventory input." }, 400));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-item");
    form.set("catalogItemId", "cat_1");
    form.set("selectedOptions", "[]");
    form.set("storageLocationId", "loc_1");
    form.set("totalQuantity", "3");

    const result = await inventoryAction({
      request: new Request("http://localhost/account/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ error: "Bad inventory input." });
  });

  it("carries inventory item create receipts into the detail redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "inv_created", version: 7 }, 201, commitHeaders("61")));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-item");
    form.set("catalogItemId", "cat_1");
    form.set("selectedOptions", "[]");
    form.set("storageLocationId", "loc_1");
    form.set("totalQuantity", "3");

    const response = (await inventoryAction({
      request: new Request("http://localhost/account/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/inventory/items/inv_created?");
    expect(location).not.toContain("feedbackWorkflow=");
    expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("61");
  });

  it("returns to Sell List after creating inventory from a Sell List recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "inv_created", version: 7 }, 201, commitHeaders("62")));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-item");
    form.set("catalogItemId", "cat_1");
    form.set("selectedOptions", "[]");
    form.set("storageLocationId", "loc_1");
    form.set("totalQuantity", "3");
    form.set("returnTo", "/account/sell-list");

    const response = (await inventoryAction({
      request: new Request("http://localhost/account/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/sell-list?");
    expect(location).not.toContain("feedbackWorkflow=");
    expect(location).not.toContain("feedbackEntityId=");
    expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("62");
  });

  it("loads inventory item detail through the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            item_id: "inv_1",
            account_id: "acc_1",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::dim_condition:near_mint|dim_form:raw",
            item_title: "Charizard ex",
            item_subtitle: null,
            selected_options: [
              { dimensionId: "dim_condition", optionId: "near_mint" },
              { dimensionId: "dim_form", optionId: "raw" },
            ],
            product_summary: "Condition: Near Mint | Form: Raw",
            storage_location_id: "loc_1",
            storage_location_name: "North shelf",
            ship_from_code: "CHI-WH-1",
            total_quantity: 8,
            held_quantity: 1,
            available_quantity: 7,
            acquisition_cost_amount: "4.25",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            holds: [],
          }),
        );
      }),
    );

    const result = await inventoryItemLoader({
      request: new Request("http://localhost/account/inventory/items/inv_1"),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never);

    expect(result.item.available_quantity).toBe(7);
  });

  it("forwards fresh-write receipts to inventory item detail reads", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            item_id: "inv_1",
            account_id: "acc_1",
            catalog_catalog_item_id: "cat_1",
            product_id: "cat_1::condition:near_mint",
            item_title: "Charizard ex",
            item_subtitle: null,
            selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
            product_summary: "Condition: Near Mint",
            storage_location_id: "loc_1",
            storage_location_name: "North shelf",
            ship_from_code: "CHI-WH-1",
            total_quantity: 8,
            held_quantity: 1,
            available_quantity: 7,
            acquisition_cost_amount: "4.25",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            holds: [],
          }),
        );
      }),
    );

    await inventoryItemLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/items/inv_1", inventoryCommit("71"))}`,
      ),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never);

    const detailRead = requests.find((request) => request.url.includes("/api/inventory/items/inv_1"));
    expect(detailRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
  });

  it("returns bounded recovery while fresh inventory item detail is catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Inventory projection is catching up.",
              },
            },
            503,
          ),
        );
      }),
    );

    await expect(
      inventoryItemLoader({
        request: new Request(
          `http://localhost${appendFreshWriteToken("/account/inventory/items/inv_1", inventoryCommit("62"))}`,
        ),
        params: { itemId: "inv_1" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("treats expired fresh-write inventory item not-found responses as permanent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "not_found",
                message: "Inventory item not found.",
              },
            },
            404,
          ),
        );
      }),
    );

    const expiredReceipt = encodeFreshWriteReceipt({
      observedAtMs: 1,
      commitPosition: "72",
      sources: [
        {
          sourceContextName: "inventory",
          maxGlobalPosition: "72",
          eventIds: ["evt_inventory_72"],
        },
      ],
    });

    await expect(
      inventoryItemLoader({
        request: new Request(`http://localhost/account/inventory/items/inv_missing?afterWrite=${expiredReceipt}`),
        params: { itemId: "inv_missing" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("carries inventory item adjustment receipts into the detail redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "inv_1", version: 8, status: "adjusted" }, 200, commitHeaders("73")));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "adjust-item");
    form.set("quantityDelta", "2");
    form.set("reason", "Cycle count");
    form.set("reasonCode", "correction");
    form.set("note", "Counted twice");

    const response = (await inventoryItemAction({
      request: new Request("http://localhost/account/inventory/items/inv_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/inventory/items/inv_1?afterWrite=");
    expect(location).not.toContain("feedbackWorkflow=");
    expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("73");
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body).toContain('"reasonCode":"correction"');
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body).toContain('"note":"Counted twice"');
  });

  it("loads import batch workbench data through the inventory API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/import-batches/imb_1")) {
          return Promise.resolve(
            jsonResponse({
              batch_id: "imb_1",
              account_id: "acc_1",
              status: "uploaded",
              source_filename: "stock.csv",
              total_count: 1,
              accepted_count: 1,
              rejected_count: 0,
              committed_count: 0,
              created_at: "2026-05-09T00:00:00.000Z",
              updated_at: "2026-05-09T00:00:00.000Z",
              rows: [],
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                batch_id: "imb_1",
                account_id: "acc_1",
                status: "uploaded",
                source_filename: "stock.csv",
                total_count: 1,
                accepted_count: 1,
                rejected_count: 0,
                committed_count: 0,
                created_at: "2026-05-09T00:00:00.000Z",
                updated_at: "2026-05-09T00:00:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await inventoryImportsLoader({
      request: new Request("http://localhost/account/inventory/imports/imb_1"),
      params: { batchId: "imb_1" },
      context: undefined,
    } as never);

    expect(result.batches.items).toHaveLength(1);
    expect(result.detail?.batch_id).toBe("imb_1");
  });

  it("renders a freshly committed mixed import batch without forwarding freshness to secondary reads", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/import-batches/imb_mixed")) {
          return Promise.resolve(
            jsonResponse({
              batch_id: "imb_mixed",
              account_id: "acc_1",
              status: "committed",
              source_key: "native-csv",
              adapter_version: 1,
              quantity_mode: "add",
              default_storage_location_id: "loc_1",
              source_filename: "mixed.csv",
              total_count: 2,
              accepted_count: 1,
              rejected_count: 1,
              committed_count: 1,
              created_at: "2026-05-09T00:00:00.000Z",
              updated_at: "2026-05-09T00:00:00.000Z",
              rows: [
                {
                  row_id: "imr_accepted",
                  batch_id: "imb_mixed",
                  row_number: 2,
                  status: "committed",
                  raw_row: {},
                  external_reference: null,
                  row_fingerprint: "native-csv|2|cat_1",
                  quantity_mode: "add",
                  quantity_delta: 2,
                  set_quantity: null,
                  source_price_amount: null,
                  resolution_status: "native",
                  catalog_item_id: "cat_1",
                  product_id: "cat_1::condition:near_mint",
                  selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
                  storage_location_id: "loc_1",
                  total_quantity: 2,
                  acquisition_cost_amount: null,
                  seller_sku: null,
                  listing_price_amount: "4.44",
                  listing_quantity_cap: 1,
                  row_note: null,
                  validation_errors: [],
                  committed_inventory_item_id: "inv_committed",
                  committed_listing_id: null,
                  committed_at: "2026-05-09T00:00:01.000Z",
                  created_at: "2026-05-09T00:00:00.000Z",
                  updated_at: "2026-05-09T00:00:01.000Z",
                },
                {
                  row_id: "imr_rejected",
                  batch_id: "imb_mixed",
                  row_number: 3,
                  status: "rejected",
                  raw_row: {},
                  external_reference: null,
                  row_fingerprint: "native-csv|3|cat_missing",
                  quantity_mode: "add",
                  quantity_delta: null,
                  set_quantity: null,
                  source_price_amount: null,
                  resolution_status: "unresolved",
                  catalog_item_id: "cat_missing",
                  product_id: null,
                  selected_options: [],
                  storage_location_id: "loc_1",
                  total_quantity: 2,
                  acquisition_cost_amount: null,
                  seller_sku: null,
                  listing_price_amount: null,
                  listing_quantity_cap: null,
                  row_note: "rejected",
                  validation_errors: ["Catalog item was not found."],
                  committed_inventory_item_id: null,
                  committed_listing_id: null,
                  committed_at: null,
                  created_at: "2026-05-09T00:00:00.000Z",
                  updated_at: "2026-05-09T00:00:00.000Z",
                },
              ],
            }),
          );
        }

        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(
          jsonResponse({
            items: [],
            total: 0,
            count: 0,
          }),
        );
      }),
    );

    const result = await inventoryImportsLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/imports/imb_mixed", inventoryCommit("409"))}`,
      ),
      params: { batchId: "imb_mixed" },
      context: undefined,
    } as never);

    expect(result.detail).toMatchObject({
      batch_id: "imb_mixed",
      status: "committed",
      accepted_count: 1,
      rejected_count: 1,
      committed_count: 1,
    });
    expect(result.detail?.rows).toEqual([
      expect.objectContaining({
        status: "committed",
        committed_inventory_item_id: "inv_committed",
      }),
      expect.objectContaining({
        status: "rejected",
        validation_errors: ["Catalog item was not found."],
      }),
    ]);

    const detailRead = requests.find((request) => request.url.includes("/api/inventory/import-batches/imb_mixed"));
    const importListRead = requests.find(
      (request) => request.url.includes("/api/inventory/import-batches") && !request.url.includes("imb_mixed"),
    );
    const storageLocationRead = requests.find((request) => request.url.includes("/api/inventory/storage-locations"));

    expect(detailRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(importListRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
    expect(storageLocationRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
  });

  it("returns route-owned import recovery while fresh committed batch detail is catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/inventory/import-batches/imb_pending")) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Inventory import projection is catching up.",
                },
              },
              503,
            ),
          );
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await inventoryImportsLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/imports/imb_pending", inventoryCommit("410"))}`,
      ),
      params: { batchId: "imb_pending" },
      context: undefined,
    } as never);

    expect(result.detail).toBeNull();
    expect(result.detailLoadMessage).toBe("The import batch is still updating. Reload this page in a moment.");
    expect(result.batches.items).toEqual([]);
    expect(result.storageLocations.items).toEqual([]);
  });

  it("creates and commits import batches through route actions", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              jobId: url.includes("/commit") ? "job_commit" : "job_create",
              status: "queued",
              payload: { accountId: "acc_1", batchId: url.includes("/commit") ? "imb_1" : undefined },
              progress: { phase: "queued", completed: 0, total: 1, currentRowId: null, message: null },
              result: null,
              errorMessage: null,
              createdAt: "2026-05-09T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
              updatedAt: "2026-05-09T00:00:00.000Z",
            },
            202,
          ),
        );
      }),
    );

    const createForm = new URLSearchParams();
    createForm.set("intent", "create-batch");
    createForm.set("csvText", "catalogItemId,storageLocationId,totalQuantity\ncat_1,loc_1,1");
    createForm.set("sourceFilename", "stock.csv");
    const createResponse = await inventoryImportsAction({
      request: new Request("http://localhost/account/inventory/imports", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: createForm.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    const commitForm = new URLSearchParams();
    commitForm.set("intent", "commit-batch");
    commitForm.set("batchId", "imb_1");
    const commitResponse = await inventoryImportsAction({
      request: new Request("http://localhost/account/inventory/imports/imb_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: commitForm.toString(),
      }),
      params: { batchId: "imb_1" },
      context: undefined,
    } as never);

    expect(createResponse).toBeInstanceOf(Response);
    expect((createResponse as Response).headers.get("Location")).toBe("/account/inventory/imports?jobId=job_create");
    expect(commitResponse).toBeInstanceOf(Response);
    expect((commitResponse as Response).headers.get("Location")).toBe(
      "/account/inventory/imports/imb_1?jobId=job_commit",
    );
    expect(requestedUrls.some((url) => url.includes("/api/inventory/import-batches/imb_1/commit"))).toBe(true);
  });

  it("carries storage location write receipts into the list redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "loc_created", version: 3 }, 201, commitHeaders("63")));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-location");
    form.set("name", "North shelf");
    form.set("shipFromCode", "CHI-WH-1");
    form.set("shipFromName", "Inventory");
    form.set("shipFromLine1", "100 Test Lane");
    form.set("shipFromCity", "Chicago");
    form.set("shipFromState", "IL");
    form.set("shipFromPostalCode", "60601");
    form.set("shipFromCountry", "US");

    const response = (await inventoryLocationsAction({
      request: new Request("http://localhost/account/inventory/locations", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/inventory/locations?afterWrite=");
    expect(readFreshWriteToken(`http://localhost${location}`)?.commitPosition).toBe("63");
  });

  it("returns bounded recovery while fresh storage locations are catching up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Inventory storage locations are catching up.",
              },
            },
            503,
          ),
        );
      }),
    );

    const result = await inventoryLocationsLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/inventory/locations", inventoryCommit("64"))}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.locations.items).toEqual([]);
    expect(result.loadError).toBe("Storage locations are still updating. Reload this page in a moment.");
  });

  it("surfaces inventory item action validation errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ error: "Hold exceeds availability." }, 400));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "create-hold");
    form.set("quantity", "5");
    form.set("reason", "Checkout");

    const result = await inventoryItemAction({
      request: new Request("http://localhost/account/inventory/items/inv_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { itemId: "inv_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({ error: "Hold exceeds availability." });
  });
});
