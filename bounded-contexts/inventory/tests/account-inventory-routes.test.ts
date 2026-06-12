import { describe, expect, it, vi } from "vitest";
import {
  action as inventoryAction,
  loader as inventoryLoader,
} from "../routes/marketplace/account-inventory";
import {
  action as inventoryImportsAction,
  loader as inventoryImportsLoader,
} from "../routes/marketplace/account-inventory-imports";
import {
  action as inventoryItemAction,
  loader as inventoryItemLoader,
} from "../routes/marketplace/account-inventory-item";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    expect(requestedUrls.some((url) => url.includes("/api/inventory/import-batches/imb_1/commit"))).toBe(true);
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
