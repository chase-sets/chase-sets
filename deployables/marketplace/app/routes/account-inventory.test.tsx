import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InventoryRecordListPage } from "@chase-sets/inventory/web";
import { action as inventoryAction, loader as inventoryLoader } from "./account-inventory";
import {
  action as inventoryRecordAction,
  loader as inventoryRecordLoader,
} from "./account-inventory-record";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("marketplace inventory routes", () => {
  it("renders inventory content into HTML before hydration", () => {
    const html = renderToString(
      <InventoryRecordListPage
        data={{
          items: [
            {
              record_id: "inv_1",
              account_id: "acc_1",
              catalog_item_id: "cat_charizard",
              item_title: "Charizard ex",
              catalog_version_key:
                "cat_charizard::dim_condition:near_mint|dim_form:raw",
              item_subtitle: "199/165",
              version_selection: [
                { dimensionId: "dim_condition", choiceId: "near_mint" },
                { dimensionId: "dim_form", choiceId: "raw" },
              ],
              version_summary: "Condition: Near Mint | Form: Raw",
              storage_location_id: "loc_1",
              storage_location_name: "North shelf",
              ship_from_code: "CHI-WH-1",
              total_quantity: 12,
              held_quantity: 2,
              available_quantity: 10,
              acquisition_cost_amount: "4.25",
              created_at: "2026-03-31T00:00:00.000Z",
              updated_at: "2026-03-31T00:00:00.000Z",
            },
          ],
        }}
        locations={[
          {
            storage_location_id: "loc_1",
            account_id: "acc_1",
            name: "North shelf",
            description: "Singles",
            ship_from_code: "CHI-WH-1",
            is_archived: false,
            updated_at: "2026-03-31T00:00:00.000Z",
          },
        ]}
      />,
    );

    expect(html).toContain("Inventory");
    expect(html).toContain("Charizard ex");
    expect(html).toContain("North shelf");
  });

  it("loads inventory records and locations through the inventory API", async () => {
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

    expect(result.records.items).toEqual([]);
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
    form.set("intent", "create-record");
    form.set("catalogItemId", "cat_1");
    form.set("versionSelection", "[]");
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

  it("loads inventory record detail through the inventory API", async () => {
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
            record_id: "inv_1",
            account_id: "acc_1",
            catalog_item_id: "cat_charizard",
            catalog_version_key:
              "cat_charizard::dim_condition:near_mint|dim_form:raw",
            item_title: "Charizard ex",
            item_subtitle: null,
            version_selection: [
              { dimensionId: "dim_condition", choiceId: "near_mint" },
              { dimensionId: "dim_form", choiceId: "raw" },
            ],
            version_summary: "Condition: Near Mint | Form: Raw",
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

    const result = await inventoryRecordLoader({
      request: new Request("http://localhost/account/inventory/records/inv_1"),
      params: { recordId: "inv_1" },
      context: undefined,
    } as never);

    expect(result.record.available_quantity).toBe(7);
  });

  it("surfaces record action validation errors", async () => {
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

    const result = await inventoryRecordAction({
      request: new Request("http://localhost/account/inventory/records/inv_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { recordId: "inv_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({ error: "Hold exceeds availability." });
  });
});

