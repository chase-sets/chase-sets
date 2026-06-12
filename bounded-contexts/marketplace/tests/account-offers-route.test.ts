import { describe, expect, it, vi } from "vitest";
import { loader as submittedOfferLoader } from "../routes/account-offer-submitted";
import { loader as submittedOffersLoader } from "../routes/account-offers-submitted";
import { loader as offerMatchLoader } from "../routes/account-offer-match";
import { loader as offerMatchesLoader } from "../routes/account-offer-matches";

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
});
