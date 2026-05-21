import { describe, expect, it, vi } from "vitest";
import { loader as submittedOfferLoader } from "@chase-sets/marketplace/routes/account-offer-submitted";
import { loader as submittedOffersLoader } from "@chase-sets/marketplace/routes/account-offers-submitted";
import { loader as offerMatchLoader } from "@chase-sets/marketplace/routes/account-offer-match";
import { loader as offerMatchesLoader } from "@chase-sets/marketplace/routes/account-offer-matches";
import { action as itemDetailAction } from "@chase-sets/discovery/routes/item-detail";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("marketplace offer routes", () => {
  it("loads submitted offers through the marketplace API", async () => {
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

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                offer_id: "off_1",
                buyer_account_id: "acc_1",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                price_amount: "350.00",
                quantity_requested: 1,
                status: "submitted",
                listing_id: "lst_1",
                listing_price_amount: "375.00",
                listing_quantity_cap: 1,
                listing_visible_quantity: 1,
                offer_price_gap_amount: "25.00",
                offer_to_listing_price_bps: 9333,
                seller_available_quantity: 1,
                seller_listing_availability_status: "available",
                can_fulfill: true,
                in_sell_list: false,
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-03-31T00:00:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await submittedOffersLoader({
      request: new Request("http://localhost/account/offers/submitted"),
      params: {},
      context: undefined,
    } as never);

    expect(result.submittedOffers.items).toHaveLength(1);
    expect(result.submittedOffers.items[0]?.offer_id).toBe("off_1");
  });

  it("loads submitted offer detail through the marketplace API", async () => {
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

        return Promise.resolve(
          jsonResponse({
            offer_id: "off_1",
            buyer_account_id: "acc_1",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            selected_options: [],
            product_summary: null,
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            listing_id: "lst_1",
            listing_price_amount: "375.00",
            listing_quantity_cap: 1,
            listing_visible_quantity: 1,
            offer_price_gap_amount: "25.00",
            offer_to_listing_price_bps: 9333,
            seller_available_quantity: 1,
            seller_listing_availability_status: "available",
            can_fulfill: true,
            in_sell_list: false,
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
          }),
        );
      }),
    );

    const result = await submittedOfferLoader({
      request: new Request("http://localhost/account/offers/submitted/off_1"),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result.submittedOffer.offer_id).toBe("off_1");
  });

  it("loads offer matches through the marketplace API", async () => {
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
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                offer_id: "off_1",
                buyer_account_id: "acc_buyer",
                buyer_display_name: "Buyer One",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                price_amount: "350.00",
                quantity_requested: 1,
                status: "submitted",
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-03-31T00:00:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await offerMatchesLoader({
      request: new Request("http://localhost/account/offers/matches"),
      params: {},
      context: undefined,
    } as never);

    expect(result.offerMatches.items[0]?.buyer_display_name).toBe("Buyer One");
  });

  it("loads offer match detail through the marketplace API", async () => {
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
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            offer_id: "off_1",
            buyer_account_id: "acc_buyer",
            buyer_display_name: "Buyer One",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            selected_options: [],
            product_summary: null,
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
          }),
        );
      }),
    );

    const result = await offerMatchLoader({
      request: new Request("http://localhost/account/offers/matches/off_1"),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result.offerMatch.offer_id).toBe("off_1");
    expect(result.offerMatch.buyer_display_name).toBe("Buyer One");
  });

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
    expect(location).toContain("/checkout/start?source=offer-intent");
    expect(location).toContain("catalogItemId=item-1");
    expect(location).toContain("offerPriceAmount=350.00");
    expect(location).toContain("quantity=1");
  });
});
