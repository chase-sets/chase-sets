import { describe, expect, it, vi } from "vitest";
import { action as listingsAction, loader as listingsLoader } from "../routes/account-listings";
import { readFreshWriteToken } from "@chase-sets/http/responses";

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

describe("marketplace listing routes", () => {
  it("preselects inventory when the seller enters from an inventory item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/inventory/items")) {
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
                  storage_location_id: "loc_1",
                  storage_location_name: "North shelf",
                  ship_from_code: "CHI-WH-1",
                  total_quantity: 8,
                  held_quantity: 1,
                  available_quantity: 7,
                  acquisition_cost_amount: "4.25",
                  created_at: "2026-03-31T00:00:00.000Z",
                  updated_at: "2026-03-31T00:00:00.000Z",
                },
              ],
              total: 1,
              count: 1,
            }),
          );
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

  it("creates and publishes a listing in one seller action", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("/api/auth/session")) {
        return Promise.resolve(jsonResponse({ actor: sellerActor }));
      }

      if (url.includes("/api/marketplace/account/listings/lst_1/publish")) {
        return Promise.resolve(jsonResponse({ id: "lst_1", version: 2 }));
      }

      return Promise.resolve(jsonResponse({ id: "lst_1", version: 1 }, 201));
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
    expect((result as Response).headers.get("Location")).toBe(
      "/account/listings/lst_1?feedbackWorkflow=listing-publish",
    );
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
});
