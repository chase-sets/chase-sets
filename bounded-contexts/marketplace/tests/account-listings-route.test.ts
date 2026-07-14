import { afterEach, describe, expect, it, vi } from "vitest";

const { mockRequireActorFromAuthApi, mockResolveRequiredActorFromAuthApi, mockCreateMarketplaceRequestApiClient } =
  vi.hoisted(() => ({
    mockRequireActorFromAuthApi: vi.fn(),
    mockResolveRequiredActorFromAuthApi: vi.fn(),
    mockCreateMarketplaceRequestApiClient: vi.fn(),
  }));

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
    resolveRequiredActorFromAuthApi: mockResolveRequiredActorFromAuthApi,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  MarketplaceApiError: class MarketplaceApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${status}`);
    }
  },
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
}));

import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { MarketplaceApiError } from "../support/request-support/api-client";
import { loader } from "../routes/account-listings";

describe("account listings route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an account access state instead of throwing 403 for signed-in actors without listing access", async () => {
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "forbidden",
      actor: {
        accountId: "acc_platform",
        permissions: ["accounts.view"],
      },
      requiredPermission: "listings.view",
    });
    const listSellerListings = vi.fn();
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings,
    });

    const result = await loader({
      request: new Request("http://localhost/account/listings"),
      params: {},
      context: {},
    } as never);

    expect(result).toMatchObject({
      accountAccessRequired: {
        returnTo: "/account/listings",
      },
    });
    expect(listSellerListings).not.toHaveBeenCalled();
  });

  it("applies the status filter and title search to the seller listings read", async () => {
    const listSellerListings = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      count: 0,
      limit: 100,
      offset: 0,
      statusCounts: { active: 0, draft: 0, paused: 0, withdrawn: 0 },
    });
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings,
      listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      getSellerListingAvailability: vi.fn().mockResolvedValue({
        account_id: "acc_seller",
        status: "available",
        disabled_reason_category: null,
        available_again_on: null,
        available_again_at: null,
        disabled_at: null,
        enabled_at: null,
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
      getSellerOrderCapacity: vi.fn().mockResolvedValue({
        account_id: "acc_seller",
        max_open_orders: null,
        updated_at: "2026-04-17T00:00:00.000Z",
      }),
    });

    const result = await loader({
      request: new Request("http://localhost/account/listings?status=paused&search=Charizard"),
      params: {},
      context: {},
    } as never);

    expect(listSellerListings).toHaveBeenCalledWith(expect.stringContaining("status=paused"));
    expect(listSellerListings).toHaveBeenCalledWith(expect.stringContaining("search=Charizard"));
    expect(result.filters).toEqual({ status: "paused", search: "Charizard" });
  });

  it("renders temporary seller availability state for marketplace availability fresh-write timeouts", async () => {
    const projectionTimeout = new MarketplaceApiError(503, {
      error: {
        code: "projection_freshness_timeout",
        message: "Projection freshness timed out.",
      },
    });
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      listSellerListings: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      getSellerListingAvailability: vi.fn().mockRejectedValue(projectionTimeout),
      getSellerOrderCapacity: vi.fn().mockRejectedValue(projectionTimeout),
    });
    const path = appendFreshWriteToken("/account/listings?availabilityAction=disabled", {
      commitPositions: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "52",
          eventIds: ["evt_marketplace_52"],
        },
      ],
      commitEventIds: ["evt_marketplace_52"],
    });

    const result = await loader({
      request: new Request(`http://localhost${path}`),
      params: {},
      context: {},
    } as never);

    expect(result.listingAvailability).toMatchObject({
      account_id: "acc_seller",
      status: "unavailable",
    });
    expect(result.listings).toEqual({
      items: [],
      total: 0,
      count: 0,
      limit: 100,
      offset: 0,
      statusCounts: { active: 0, draft: 0, paused: 0, withdrawn: 0 },
    });
  });

  it("recovers a scheduled away window from stale reads when its fresh read times out", async () => {
    const projectionTimeout = new MarketplaceApiError(503, {
      error: {
        code: "projection_freshness_timeout",
        message: "Projection freshness timed out.",
      },
    });
    mockResolveRequiredActorFromAuthApi.mockResolvedValue({
      kind: "authorized",
      actor: {
        accountId: "acc_seller",
        permissions: ["listings.view", "listings.manage"],
      },
    });
    mockCreateMarketplaceRequestApiClient
      .mockReturnValueOnce({
        listSellerListings: vi.fn().mockRejectedValue(projectionTimeout),
        listSellerListingFeeLockReport: vi.fn().mockRejectedValue(projectionTimeout),
        getSellerListingAvailability: vi.fn().mockRejectedValue(projectionTimeout),
        getSellerOrderCapacity: vi.fn().mockRejectedValue(projectionTimeout),
      })
      .mockReturnValueOnce({
        listSellerListings: vi.fn().mockResolvedValue({
          items: [],
          total: 0,
          count: 0,
          limit: 100,
          offset: 0,
          statusCounts: { active: 0, draft: 0, paused: 0, withdrawn: 0 },
        }),
        listSellerListingFeeLockReport: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
        getSellerListingAvailability: vi.fn().mockResolvedValue({
          account_id: "acc_seller",
          status: "available",
          disabled_reason_category: null,
          available_again_on: null,
          available_again_at: null,
          disabled_at: null,
          enabled_at: "2026-07-01T00:00:00.000Z",
          away_window_starts_at: null,
          away_window_ends_at: null,
          away_window_reason_category: null,
          updated_at: "2026-07-01T00:00:00.000Z",
        }),
        getSellerOrderCapacity: vi.fn().mockResolvedValue({
          account_id: "acc_seller",
          max_open_orders: null,
          updated_at: "2026-07-01T00:00:00.000Z",
        }),
      });

    const destination =
      "/account/listings?settingsAction=schedule-away-window" +
      "&awayWindowReasonCategory=travel" +
      "&awayWindowStartsAt=2026-08-01T05%3A00%3A00.000Z" +
      "&awayWindowEndsAt=2026-08-10T05%3A00%3A00.000Z";
    const path = appendFreshWriteToken(destination, {
      commitPositions: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "53",
          eventIds: ["evt_marketplace_53"],
        },
      ],
      commitEventIds: ["evt_marketplace_53"],
    });

    const result = await loader({
      request: new Request(`http://localhost${path}`),
      params: {},
      context: {},
    } as never);

    expect(result.listingAvailability).toMatchObject({
      away_window_starts_at: "2026-08-01T05:00:00.000Z",
      away_window_ends_at: "2026-08-10T05:00:00.000Z",
      away_window_reason_category: "travel",
    });
  });
});
