import { describe, expect, it, vi } from "vitest";
import {
  action as inventoryAction,
  loader as inventoryLoader,
} from "@chase-sets/inventory/routes/marketplace/account-inventory";
import {
  action as inventoryItemAction,
  loader as inventoryItemLoader,
} from "@chase-sets/inventory/routes/marketplace/account-inventory-item";

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
            product_id:
              "cat_charizard::dim_condition:near_mint|dim_form:raw",
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

