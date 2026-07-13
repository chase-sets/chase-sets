import { describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { loader as submittedOfferLoader } from "../routes/account-offer-submitted";
import { loader as submittedOffersLoader } from "../routes/account-offers-submitted";
import { action as offerMatchAction, loader as offerMatchLoader } from "../routes/account-offer-match";
import { loader as offerMatchesLoader } from "../routes/account-offer-matches";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function marketplaceCommit(position = "42", eventId = "evt_marketplace_offer") {
  return {
    mode: "eventual",
    commitPosition: position,
    commitEventIds: [eventId],
    commitPositions: [
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: position,
        eventIds: [eventId],
      },
    ],
  };
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

    const submittedOffer = result.submittedOffer;
    if (!submittedOffer) {
      throw new Error("Expected submitted offer detail.");
    }
    expect(submittedOffer.offer_id).toBe("off_1");
  });

  it("returns route-owned recovery when a fresh submitted offer read hits projection freshness timeout", async () => {
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
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Projection read model did not catch up before the freshness timeout.",
              },
            },
            503,
          ),
        );
      }),
    );

    const result = await submittedOfferLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit())}`,
      ),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      submittedOffer: null,
      recovery: "fresh-write-preparing",
    });
  });

  it("returns route-owned recovery when a fresh submitted offer read hits an opaque gateway timeout", async () => {
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

        return Promise.resolve(jsonResponse(null, 504));
      }),
    );

    const result = await submittedOfferLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit())}`,
      ),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      submittedOffer: null,
      recovery: "fresh-write-preparing",
    });
  });

  it("surfaces expired submitted offer fresh-write not-found reads as normal not found", async () => {
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
          jsonResponse(
            {
              error: {
                code: "not_found",
                message: "Submitted offer not found.",
              },
            },
            404,
          ),
        );
      }),
    );

    let response: Response | null = null;
    try {
      await submittedOfferLoader({
        request: new Request(
          `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit(), 1)}`,
        ),
        params: { offerId: "off_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toContain("Submitted offer not found");
  });

  it("surfaces unclassified submitted offer fresh-write failures normally", async () => {
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
          jsonResponse(
            {
              error: {
                code: "provider_failed",
                message: "Provider failed.",
              },
            },
            503,
          ),
        );
      }),
    );

    await expect(
      submittedOfferLoader({
        request: new Request(
          `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit())}`,
        ),
        params: { offerId: "off_1" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({
      status: 503,
      body: {
        error: {
          code: "provider_failed",
        },
      },
    });
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

    const offerMatch = result.offerMatch;
    if (!offerMatch) {
      throw new Error("Expected offer match detail.");
    }
    expect(offerMatch.offer_id).toBe("off_1");
    expect(offerMatch.buyer_display_name).toBe("Buyer One");
  });

  it("returns route-owned recovery when a fresh offer match read hits projection freshness timeout", async () => {
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
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Projection read model did not catch up before the freshness timeout.",
              },
            },
            503,
          ),
        );
      }),
    );

    const result = await offerMatchLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/offers/matches/off_1", marketplaceCommit())}`,
      ),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      offerMatch: null,
      acceptanceTerms: null,
      recovery: "fresh-write-preparing",
    });
  });

  it("carries write consistency metadata after accepting an offer match", async () => {
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
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        if (
          url.includes("/api/marketplace/account/offers/matches/off_1/accept") &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        ) {
          return Promise.resolve(
            jsonResponse({ id: "off_1", version: 2, status: "accepted" }, 201, {
              "Chase-Sets-Consistency": "eventual",
              "Chase-Sets-Commit-Receipt": encodeURIComponent(
                JSON.stringify([
                  {
                    sourceContextName: "marketplace",
                    maxGlobalPosition: "42",
                    eventIds: ["evt_offer_accepted"],
                  },
                ]),
              ),
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "accept-offer");
    form.set("feeQuoteFingerprint", "quote-current");

    const response = await offerMatchAction({
      request: new Request("http://localhost/account/offers/matches/off_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    const location = (response as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/offers\/matches\/off_1\?afterWrite=/);
    expect(readFreshWriteToken(location)?.sources).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_offer_accepted"],
      },
    ]);
  });

  it("forwards afterWrite metadata when loading a freshly accepted offer match", async () => {
    const offerDetailHeaders: Headers[] = [];
    const freshPath = appendFreshWriteToken(
      "/account/offers/matches/off_1",
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_offer_accepted"],
          },
        ],
        commitEventIds: ["evt_offer_accepted"],
      },
      Date.now(),
    );

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
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        if (url.includes("/api/marketplace/account/offers/matches/off_1")) {
          offerDetailHeaders.push(new Headers(init?.headers));
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
              status: "accepted",
              created_at: "2026-03-31T00:00:00.000Z",
              updated_at: "2026-03-31T00:00:00.000Z",
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await offerMatchLoader({
      request: new Request(`http://localhost${freshPath}`),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    const offerMatch = result.offerMatch;
    if (!offerMatch) {
      throw new Error("Expected offer match detail.");
    }
    expect(offerMatch.status).toBe("accepted");
    expect(offerDetailHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(offerDetailHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });
});
