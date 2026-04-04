import { describe, expect, it, vi } from "vitest";
import {
  loader as accountOfferLoader,
} from "./account-offer";
import {
  loader as accountOffersLoader,
} from "./account-offers";
import {
  loader as marketOfferLoader,
} from "./account-market-offer";
import {
  loader as marketOffersLoader,
} from "./account-market-offers";
import { action as itemDetailAction } from "./item-detail";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("marketplace offer routes", () => {
  it("loads buyer offer history through the marketplace API", async () => {
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
                catalog_item_id: "cat_charizard",
                catalog_version_key: "cat_charizard::",
                item_title: "Charizard",
                item_subtitle: null,
                version_selection: [],
                version_summary: null,
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

    const result = await accountOffersLoader({
      request: new Request("http://localhost/account/offers"),
      params: {},
      context: undefined,
    } as never);

    expect(result.offers.items).toHaveLength(1);
    expect(result.offers.items[0]?.offer_id).toBe("off_1");
  });

  it("loads buyer offer detail through the marketplace API", async () => {
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
            catalog_item_id: "cat_charizard",
            catalog_version_key: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            version_selection: [],
            version_summary: null,
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
          }),
        );
      }),
    );

    const result = await accountOfferLoader({
      request: new Request("http://localhost/account/offers/off_1"),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result.offer.offer_id).toBe("off_1");
  });

  it("loads seller market offers through the marketplace API", async () => {
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
                catalog_item_id: "cat_charizard",
                catalog_version_key: "cat_charizard::",
                item_title: "Charizard",
                item_subtitle: null,
                version_selection: [],
                version_summary: null,
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

    const result = await marketOffersLoader({
      request: new Request("http://localhost/account/market-offers"),
      params: {},
      context: undefined,
    } as never);

    expect(result.offers.items[0]?.buyer_display_name).toBe("Buyer One");
  });

  it("loads seller market offer detail through the marketplace API", async () => {
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
            catalog_item_id: "cat_charizard",
            catalog_version_key: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            version_selection: [],
            version_summary: null,
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
          }),
        );
      }),
    );

    const result = await marketOfferLoader({
      request: new Request("http://localhost/account/market-offers/off_1"),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result.offer.offer_id).toBe("off_1");
    expect(result.offer.buyer_display_name).toBe("Buyer One");
  });

  it("submits an item-detail offer and redirects to buyer offer history", async () => {
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
              item_id: "item-1",
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
              version_schema: null,
              updated_at: "2026-03-31T00:00:00.000Z",
            }),
          );
        }

        return Promise.resolve(jsonResponse({ id: "off_1", version: 1 }, 201));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "submit-offer");
    form.set("catalogVersionKey", "item-1::");
    form.set("versionSelection", "[]");
    form.set("versionSummary", "");
    form.set("priceAmount", "350.00");
    form.set("quantityRequested", "1");

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
    expect(response.headers.get("Location")).toBe("/account/offers");
  });
});

