import { describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, CHASE_SETS_READ_AFTER_WRITE_HEADER } from "@chase-sets/http/responses";
import { action as listingAction, loader as listingLoader } from "../routes/account-listing";
import type { MarketplaceListingTermsPreview } from "@chase-sets/marketplace/server";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

const currentQuote: MarketplaceListingTermsPreview = {
  account_type: "business",
  basis_amount: "20.00",
  marketplace_sales_fee_unit_amount: "1.00",
  seller_net_unit_amount: "19.00",
  shipping_allowance_percentage_bps: 500,
  schedule_id: "cts_current",
  agreement_id: null,
  resolved_at: "2026-04-17T00:00:00.000Z",
  fee_quote_fingerprint: "current-fingerprint",
};

function marketplaceCommit(position = "42", eventId = "evt_marketplace_listing") {
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

function freshListingRequest(path = "/account/listings/lst_1") {
  return new Request(`http://localhost${appendFreshWriteToken(path, marketplaceCommit())}`);
}

describe("marketplace listing detail route", () => {
  it("retries a fresh create redirect before treating the listing as missing", async () => {
    let listingReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/fee-history")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        listingReads += 1;
        if (listingReads === 1) {
          return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "Missing." } }, 404));
        }

        return Promise.resolve(
          jsonResponse({
            listing_id: "lst_1",
            inventory_item_id: "inv_1",
            status: "draft",
          }),
        );
      }),
    );

    const result = await listingLoader({
      request: new Request(`http://localhost/account/listings/lst_1?afterWrite=42.${Date.now()}`),
      params: { listingId: "lst_1" },
      context: undefined,
    } as never);

    expect(result.listing).toMatchObject({ listing_id: "lst_1" });
    expect(listingReads).toBe(2);
  });

  it("returns route-owned recovery data when a fresh listing read hits projection freshness timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
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

    const result = await listingLoader({
      request: freshListingRequest(),
      params: { listingId: "lst_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      listing: null,
      feeHistory: { items: [], total: 0, count: 0 },
      recovery: "fresh-write-preparing",
    });
  });

  it("does not forward listing afterWrite metadata to fee history reads", async () => {
    const feeHistoryHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/fee-history")) {
          feeHistoryHeaders.push(new Headers(init?.headers));
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        return Promise.resolve(
          jsonResponse({
            listing_id: "lst_1",
            inventory_item_id: "inv_1",
            status: "active",
          }),
        );
      }),
    );

    const result = await listingLoader({
      request: freshListingRequest(),
      params: { listingId: "lst_1" },
      context: undefined,
    } as never);

    expect(result.listing).toMatchObject({ listing_id: "lst_1" });
    expect(feeHistoryHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
  });

  it("returns the current quote when a confirmed price update is stale", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "fee_quote_stale",
                message: "Fee quote is stale.",
                currentQuote,
              },
            },
            409,
          ),
        );
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "update-price");
    form.set("priceAmount", "20.00");
    form.set("feeQuoteFingerprint", "stale-fingerprint");

    const result = await listingAction({
      request: new Request("http://localhost/account/listings/lst_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { listingId: "lst_1" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      priceDraftAmount: "20.00",
      pricePreview: currentQuote,
      error: "Fee quote is stale. Refresh the fee preview before continuing.",
    });
  });
});
