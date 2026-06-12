import { describe, expect, it, vi } from "vitest";
import { action as itemDetailAction } from "./item-detail";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("item detail offer intent route", () => {
  it("hands item-detail offers to checkout as purchase intent", async () => {
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
                permissions: ["offers.view", "offers.manage"],
              },
            }),
          );
        }

        if (url.includes("/api/marketplace/items/item-1")) {
          return Promise.resolve(
            jsonResponse({
              catalog_item_id: "item-1",
              title: "Charizard",
              subtitle: "Base Set 4/102 Holo Rare",
              description: "Item detail",
              blueprint_id: null,
              blueprint: null,
              status: "active",
              field_values: [],
              categories: [],
              tags: [],
              image_urls: [],
              market_summary: null,
              market_listings: [],
              product_schema: null,
              updated_at: "2026-03-31T00:00:00.000Z",
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "off_1", version: 1 }, 201));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "submit-offer");
    form.set("productId", "item-1::");
    form.set("selectedOptions", "[]");
    form.set("productSummary", "");
    form.set("priceAmount", "350.00");
    form.set("quantityRequested", "1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const result = await itemDetailAction({
      request: new Request("http://localhost/items/item-1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "item-1" },
      context: undefined,
    } as never);

    expect(result).toBeInstanceOf(Response);

    const response = result as Response;
    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toContain("/checkout/buy/readiness?source=offer-intent");
    expect(location).toContain("catalogItemId=item-1");
    expect(location).toContain("offerPriceAmount=350.00");
    expect(location).toContain("quantity=1");
  });
});
