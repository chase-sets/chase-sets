// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryPublicAccount } from "../support/client-support/contracts";

const { mockUseLoaderData, mockSubscribeRealtimePatches } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockSubscribeRealtimePatches: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
  };
});

vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  createRealtimeRouteSubscriptionPreset: vi.fn((id: string, topics: readonly string[]) => ({ id, topics })),
  subscribeRealtimePatches: mockSubscribeRealtimePatches,
}));

import PublicAccountRoute, { loader } from "./public-account";

function accountFixture(overrides: Partial<DiscoveryPublicAccount> = {}): DiscoveryPublicAccount {
  return {
    account_id: "acc_seller",
    account_slug: "north-store",
    account_display_name: "North Store",
    status: "active",
    created_at: "2026-01-15T00:00:00.000Z",
    average_rating_as_seller: "4.80",
    review_count_as_seller: 8,
    rating_1_count_as_seller: 0,
    rating_2_count_as_seller: 0,
    rating_3_count_as_seller: 1,
    rating_4_count_as_seller: 2,
    rating_5_count_as_seller: 5,
    average_rating_as_buyer: "5.00",
    review_count_as_buyer: 2,
    rating_1_count_as_buyer: 0,
    rating_2_count_as_buyer: 0,
    rating_3_count_as_buyer: 0,
    rating_4_count_as_buyer: 0,
    rating_5_count_as_buyer: 2,
    active_listing_count: 1,
    updated_at: "2026-05-13T00:00:00.000Z",
    reviews: {
      items: [
        {
          review_id: "rev_1",
          author_account_id: "acc_buyer",
          author_display_name: "Buyer One",
          author_role: "buyer",
          rating: 5,
          feedback: "Packed well and shipped quickly.",
          submitted_at: "2026-05-12T00:00:00.000Z",
          updated_at: "2026-05-12T00:00:00.000Z",
          reply_feedback: null,
          reply_status: null,
          reply_submitted_at: null,
        },
      ],
      total: 15,
    },
    listings: [
      {
        listing_id: "lst_1",
        listing_slug: "lst-1",
        product_slug: "product-1",
        account_id: "acc_seller",
        inventory_item_id: "inv_1",
        catalog_catalog_item_id: "cat_1",
        catalog_item_slug: "pikachu",
        product_id: "prd_1",
        item_title: "Pikachu",
        item_subtitle: null,
        selected_options: [],
        product_summary: null,
        storage_location_name: null,
        ship_from_code: "STL",
        price_amount: "12.00",
        shipping_allowance_percentage_bps: 500,
        quantity_cap: 5,
        max_units_per_order: null,
        max_units_per_day: null,
        max_units_per_customer_account: null,
        status: "active",
        seller_slug: "north-store",
        seller_listing_availability_status: "available",
        seller_listing_availability_reason_category: null,
        seller_listing_available_again_on: null,
        seller_display_name: "North Store",
        seller_average_rating: "4.80",
        seller_review_count: 8,
        google_shopping_structured_data_payload: null,
        visible_quantity: 3,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("discovery public account loader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("requests revealed, paginated reviews for the requested role and page", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(accountFixture({ account_slug: "north-store" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loader({
      request: new Request("http://localhost/accounts/north-store?role=seller&page=2"),
      params: { accountSlug: "north-store" },
      context: undefined,
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(requestedUrl).toContain("/accounts/north-store");
    expect(requestedUrl).toContain("role=seller");
    expect(requestedUrl).toContain("limit=10");
    expect(requestedUrl).toContain("offset=10");
    expect((result as { account: DiscoveryPublicAccount; reviewRole: string }).account.account_slug).toBe(
      "north-store",
    );
    expect((result as { reviewRole: string }).reviewRole).toBe("seller");
  });

  it("redirects to the canonical slug when the requested slug has been superseded", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(accountFixture({ account_slug: "north-store" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await loader({
        request: new Request("http://localhost/accounts/north-store-old"),
        params: { accountSlug: "north-store-old" },
        context: undefined,
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(301);
    expect((thrown as Response).headers.get("Location")).toBe("/accounts/north-store");
  });
});

describe("discovery public account route", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders role-split reputation summaries and paginated, role-filterable reviews", () => {
    mockUseLoaderData.mockReturnValue({
      account: accountFixture(),
      notFound: false,
      canonicalUrl: "http://localhost/accounts/north-store",
      reviewRole: null,
      reviewPage: 2,
      search: "?page=2",
    });

    render(<PublicAccountRoute />);

    expect(screen.getAllByText("North Store").length).toBeGreaterThan(0);
    // Role-split summaries: both dimensions render from a single payload.
    expect(screen.getAllByText("As seller").length).toBeGreaterThan(0);
    expect(screen.getAllByText("As buyer").length).toBeGreaterThan(0);
    // Member since, sourced from created_at (never email/real name/order detail).
    expect(screen.getByText("January 2026")).toBeTruthy();
    // Revealed review content and pagination for the 15-review total.
    expect(screen.getByText("Packed well and shipped quickly.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();
    // The dangling-link fix: the seller's own listing card links back to this
    // same account route with the feedback anchor.
    expect(screen.getByRole("link", { name: "View listing" }).getAttribute("href")).toBe("/listings/lst-1");
  });

  it("renders a minimal unavailable profile for a suspended account, withholding listings and reviews", () => {
    mockUseLoaderData.mockReturnValue({
      account: accountFixture({
        status: "suspended",
        active_listing_count: 0,
        reviews: { items: [], total: 0 },
        listings: [],
      }),
      notFound: false,
      canonicalUrl: "http://localhost/accounts/north-store",
      reviewRole: null,
      reviewPage: 1,
      search: "",
    });

    render(<PublicAccountRoute />);

    expect(screen.getByText("Account unavailable")).toBeTruthy();
    expect(screen.queryByText("As seller")).toBeNull();
    expect(screen.queryByText("Packed well and shipped quickly.")).toBeNull();
    expect(screen.queryByText("Pikachu")).toBeNull();
  });

  it("renders the not-found state when no account matches", () => {
    mockUseLoaderData.mockReturnValue({
      account: null,
      notFound: true,
      canonicalUrl: null,
      reviewRole: null,
      reviewPage: 1,
      search: "",
    });

    render(<PublicAccountRoute />);

    expect(screen.getByText("Account not found")).toBeTruthy();
  });
});
