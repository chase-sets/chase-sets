import { afterEach, describe, expect, it, vi } from "vitest";
import { action as listingsAction, loader as listingsLoader } from "../routes/account-listings";
import {
  appendCompactPostWriteToken,
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  readCompactPostWriteToken,
  type PostWriteTokenPayload,
} from "@chase-sets/http/responses";
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

const listingAvailability = {
  account_id: "acc_1",
  status: "available",
  disabled_reason_category: null,
  available_again_on: null,
  available_again_at: null,
  disabled_at: null,
  enabled_at: null,
  updated_at: "2026-04-17T00:00:00.000Z",
};

let restorePostWriteTokenStore: (() => void) | null = null;

afterEach(() => {
  restorePostWriteTokenStore?.();
  restorePostWriteTokenStore = null;
  vi.unstubAllGlobals();
});

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
      const token = `pwt_listings${String(nextToken++).padStart(15, "0")}`;
      payloads.set(token, payload);
      storeCalls.push({ payload, ...options });
      return token;
    },
    async resolvePostWriteToken(token: string) {
      return payloads.get(token) ?? null;
    },
  };
}

describe("marketplace listings workbench route", () => {
  it("marks seller availability disable redirects with the pending availability action", async () => {
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
          jsonResponse({ accountId: "acc_1", version: 2, status: "unavailable" }, 200, {
            "Chase-Sets-Consistency": "eventual",
            "Chase-Sets-Commit-Position": "43",
          }),
        );
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "disable-listing-availability");
    form.set("reasonCategory", "operations");

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
    expect(location).toMatch(/^\/account\/listings\?availabilityAction=disabled&postWriteToken=/);
    expect(readCompactPostWriteToken(location)).toMatch(/^pwt_listings/);
    expect(location).not.toContain("afterWrite=");
    expect(store.storeCalls[0]?.payload.receipt.commitPosition).toBe("43");
  });

  it("forwards afterWrite metadata when refreshing listing availability", async () => {
    const availabilityHeaders: Headers[] = [];
    const freshPath = appendFreshWriteToken(
      "/account/listings",
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "43",
            eventIds: ["evt_listing_availability"],
          },
        ],
        commitEventIds: ["evt_listing_availability"],
      },
      Date.now(),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/marketplace/account/listing-availability")) {
          availabilityHeaders.push(new Headers(init?.headers));
          return Promise.resolve(
            jsonResponse({
              ...listingAvailability,
              status: "unavailable",
              disabled_reason_category: "audit",
              updated_at: "2026-04-18T00:00:00.000Z",
            }),
          );
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsLoader({
      request: new Request(`http://localhost${freshPath}`),
      params: {},
      context: undefined,
    } as never);

    expect(result.listingAvailability.status).toBe("unavailable");
    expect(availabilityHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(availabilityHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });

  it("resolves compact tokens when refreshing listing availability", async () => {
    const store = createTestPostWriteTokenStore();
    const compactToken = "pwt_listings000000001";
    store.seed(compactToken, {
      receipt: {
        observedAtMs: Date.now(),
        sources: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "43",
            eventIds: ["evt_listing_availability"],
          },
        ],
      },
    });
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
    const availabilityHeaders: Headers[] = [];
    const compactPath = appendCompactPostWriteToken("/account/listings?availabilityAction=disabled", compactToken);

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/api/marketplace/account/listing-availability")) {
          availabilityHeaders.push(new Headers(init?.headers));
          return Promise.resolve(
            jsonResponse({
              ...listingAvailability,
              status: "unavailable",
              disabled_reason_category: "audit",
              updated_at: "2026-04-18T00:00:00.000Z",
            }),
          );
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await listingsLoader({
      request: new Request(`http://localhost${compactPath}`),
      params: {},
      context: undefined,
    } as never);

    expect(result.listingAvailability.status).toBe("unavailable");
    expect(compactPath).toContain("postWriteToken=");
    expect(compactPath).not.toContain("afterWrite=");
    expect(compactPath).not.toContain("evt_listing_availability");
    expect(availabilityHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(availabilityHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });

  it("does not load stale listings page data when a compact post-write token cannot resolve", async () => {
    const store = createTestPostWriteTokenStore();
    restorePostWriteTokenStore = configureMarketplacePostWriteTokenStoreForTests(store);
    let pageReads = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        pageReads += 1;
        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    await expect(
      listingsLoader({
        request: new Request(
          `http://localhost${appendCompactPostWriteToken("/account/listings", "pwt_missing000000000000")}`,
        ),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toThrow("Compact post-write token could not be resolved.");
    expect(pageReads).toBe(0);
  });

  it("pauses selected listings in bulk and reports per-row outcomes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        if (url.includes("/account/listings/lst_1/pause")) {
          return Promise.resolve(jsonResponse({ id: "lst_1", version: 2, status: "paused" }));
        }

        if (url.includes("/account/listings/lst_2/pause")) {
          return Promise.resolve(
            jsonResponse({ error: { code: "validation_failed", message: "Listing is withdrawn." } }, 400),
          );
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "bulk-pause-listings");
    form.append("listingIds", "lst_1");
    form.append("listingIds", "lst_2");

    const result = await listingsAction({
      request: new Request("http://localhost/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).not.toBeInstanceOf(Response);
    const bulkResult = result as {
      bulkActionOutcomes: Array<{ listingId: string; outcome: string; message: string | null }>;
    };
    expect(bulkResult.bulkActionOutcomes).toHaveLength(2);
    expect(bulkResult.bulkActionOutcomes.find((outcome) => outcome.listingId === "lst_1")).toMatchObject({
      outcome: "success",
      message: null,
    });
    expect(bulkResult.bulkActionOutcomes.find((outcome) => outcome.listingId === "lst_2")).toMatchObject({
      outcome: "error",
    });
  });

  it("withdraws selected listings in bulk", async () => {
    const withdrawnIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(jsonResponse({ actor: sellerActor }));
        }

        const match = url.match(/\/account\/listings\/([^/]+)\/withdraw/);
        if (match) {
          withdrawnIds.push(match[1]!);
          return Promise.resolve(jsonResponse({ id: match[1], version: 2, status: "withdrawn" }));
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "bulk-withdraw-listings");
    form.append("listingIds", "lst_3");

    const result = await listingsAction({
      request: new Request("http://localhost/account/listings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(withdrawnIds).toEqual(["lst_3"]);
    const bulkResult = result as { bulkActionOutcomes: Array<{ listingId: string; outcome: string }> };
    expect(bulkResult.bulkActionOutcomes).toEqual([
      { listingId: "lst_3", label: expect.any(String), outcome: "success", message: null },
    ]);
  });
});
