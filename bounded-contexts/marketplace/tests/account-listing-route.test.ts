import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCompactPostWriteToken,
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  encodeCommitReceipt,
  readCompactPostWriteToken,
  type PostWriteTokenPayload,
} from "@chase-sets/http/responses";
import { action as listingAction, loader as listingLoader } from "../routes/account-listing";
import type { MarketplaceListingTermsPreview } from "@chase-sets/marketplace/server";
import { configureMarketplacePostWriteTokenStoreForTests } from "../support/route-support/post-write-tokens";

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

const currentQuote: MarketplaceListingTermsPreview = {
  account_type: "business",
  basis_amount: "20.00",
  marketplace_sales_fee_unit_amount: "1.00",
  seller_net_unit_amount: "19.00",
  marketplace_sales_fee_percentage_bps: 500,
  marketplace_sales_fee_fixed_amount: "0.00",
  marketplace_sales_fee_cap_amount: "25.00",
  shipping_allowance_percentage_bps: 500,
  schedule_id: "cts_current",
  agreement_id: null,
  resolved_at: "2026-04-17T00:00:00.000Z",
  fee_quote_fingerprint: "current-fingerprint",
};

let restorePostWriteTokenStore: (() => void) | null = null;

afterEach(() => {
  restorePostWriteTokenStore?.();
  restorePostWriteTokenStore = null;
  vi.unstubAllGlobals();
});

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

function createTestPostWriteTokenStore() {
  const payloads = new Map<string, PostWriteTokenPayload>();
  const storeCalls: Array<Readonly<{ payload: PostWriteTokenPayload; nowMs: number; ttlMs: number }>> = [];
  let nextToken = 1;

  return {
    storeCalls,
    seed(token: string, payload: PostWriteTokenPayload) {
      payloads.set(token, payload);
    },
    async storePostWriteToken(payload: PostWriteTokenPayload, options: Readonly<{ nowMs: number; ttlMs: number }>) {
      const token = `pwt_listing${String(nextToken++).padStart(16, "0")}`;
      payloads.set(token, payload);
      storeCalls.push({ payload, ...options });
      return token;
    },
    async resolvePostWriteToken(token: string) {
      return payloads.get(token) ?? null;
    },
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

  it("resolves compact listing tokens before forwarding destination freshness", async () => {
    const store = createTestPostWriteTokenStore();
    const compactToken = "pwt_listing000000000001";
    store.seed(compactToken, {
      receipt: {
        observedAtMs: Date.now(),
        sources: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_marketplace_listing"],
          },
        ],
      },
    });
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
    const listingHeaders: Headers[] = [];
    const browserPath = appendCompactPostWriteToken("/account/listings/lst_1", compactToken);

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/fee-history")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        listingHeaders.push(new Headers(init?.headers));
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
      request: new Request(`http://localhost${browserPath}`),
      params: { listingId: "lst_1" },
      context: undefined,
    } as never);

    expect(result.listing).toMatchObject({ listing_id: "lst_1" });
    expect(browserPath).toContain("postWriteToken=");
    expect(browserPath).not.toContain("afterWrite=");
    expect(browserPath).not.toContain("evt_marketplace_listing");
    expect(listingHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
  });

  it("does not load stale listing detail when a compact post-write token cannot resolve", async () => {
    const store = createTestPostWriteTokenStore();
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
    let listingReads = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        listingReads += 1;
        return Promise.resolve(
          jsonResponse({
            listing_id: "lst_1",
            inventory_item_id: "inv_1",
            status: "active",
          }),
        );
      }),
    );

    await expect(
      listingLoader({
        request: new Request(
          `http://localhost${appendCompactPostWriteToken("/account/listings/lst_1", "pwt_missing000000000000")}`,
        ),
        params: { listingId: "lst_1" },
        context: undefined,
      } as never),
    ).rejects.toThrow("Compact post-write token could not be resolved.");
    expect(listingReads).toBe(0);
  });

  it("emits compact listing redirect tokens without raw receipt details", async () => {
    const store = createTestPostWriteTokenStore();
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        return Promise.resolve(
          jsonResponse({ id: "lst_1", version: 2 }, 200, {
            "Chase-Sets-Consistency": "eventual",
            [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
              {
                sourceContextName: "marketplace",
                maxGlobalPosition: "42",
                eventIds: ["evt_marketplace_publish"],
              },
            ]),
          }),
        );
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "publish");
    form.set("feeQuoteFingerprint", "quote-1");

    const result = await listingAction({
      request: new Request("http://localhost/account/listings/lst_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { listingId: "lst_1" },
      context: undefined,
    } as never);

    const location = (result as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/listings\/lst_1\?postWriteToken=/);
    expect(readCompactPostWriteToken(location)).toMatch(/^pwt_listing/);
    expect(location).not.toContain("afterWrite=");
    expect(location).not.toContain("postWriteHandoff=");
    expect(location).not.toContain("evt_marketplace_publish");
    expect(store.storeCalls[0]?.payload.receipt.sources).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_marketplace_publish"],
      },
    ]);
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

  it("redirects without a post-write token when a no-op price update commits no new events", async () => {
    const store = createTestPostWriteTokenStore();
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        // The domain suppresses the price-updated event when the commanded price matches
        // current state, so the API responds with success and the unchanged version but no
        // commit receipt (no new events were appended).
        return Promise.resolve(jsonResponse({ id: "lst_1", version: 7, status: "price-updated" }));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "update-price");
    form.set("priceAmount", "20.00");
    form.set("feeQuoteFingerprint", "current-fingerprint");

    const result = await listingAction({
      request: new Request("http://localhost/account/listings/lst_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { listingId: "lst_1" },
      context: undefined,
    } as never);

    const location = (result as Response).headers.get("Location") ?? "";
    expect(location).toBe("/account/listings/lst_1");
    expect(location).not.toContain("postWriteToken=");
    expect(location).not.toContain("afterWrite=");
    expect(store.storeCalls).toHaveLength(0);
  });
});
