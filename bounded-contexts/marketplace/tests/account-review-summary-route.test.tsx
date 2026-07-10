// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { jsonResponse, requestUrl } from "./test-support/http";

const { mockUseLoaderData, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
  };
});

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

import MarketplaceAccountReviewSummaryRoute, { loader } from "../routes/marketplace/account-review-summary";

describe("marketplace account review summary route", () => {
  beforeEach(() => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_1",
      permissions: ["reputation.view"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads the current account summary and public reviews", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/accounts/acc_1/review-summary")) {
          return Promise.resolve(
            jsonResponse({
              account_id: "acc_1",
              account_display_name: "North Store",
              average_rating_as_seller: "4.75",
              review_count_as_seller: 8,
              rating_1_count_as_seller: 0,
              rating_2_count_as_seller: 0,
              rating_3_count_as_seller: 1,
              rating_4_count_as_seller: 2,
              rating_5_count_as_seller: 5,
              average_rating_as_buyer: null,
              review_count_as_buyer: 0,
              rating_1_count_as_buyer: 0,
              rating_2_count_as_buyer: 0,
              rating_3_count_as_buyer: 0,
              rating_4_count_as_buyer: 0,
              rating_5_count_as_buyer: 0,
              updated_at: "2026-04-02T00:00:00.000Z",
            }),
          );
        }

        if (url.includes("/api/marketplace/accounts/acc_1/reviews")) {
          return Promise.resolve(
            jsonResponse({
              items: [],
              total: 0,
              count: 0,
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/reviews"),
      params: {},
      context: undefined,
    } as never);

    expect(result.summary.account_display_name).toBe("North Store");
    expect(result.reviews).toEqual({
      items: [],
      total: 0,
      count: 0,
    });
  });

  it("renders summary links for written and received reviews", () => {
    mockUseLoaderData.mockReturnValue({
      summary: {
        account_id: "acc_1",
        account_display_name: "North Store",
        average_rating_as_seller: "4.75",
        review_count_as_seller: 8,
        rating_1_count_as_seller: 0,
        rating_2_count_as_seller: 0,
        rating_3_count_as_seller: 1,
        rating_4_count_as_seller: 2,
        rating_5_count_as_seller: 5,
        average_rating_as_buyer: null,
        review_count_as_buyer: 0,
        rating_1_count_as_buyer: 0,
        rating_2_count_as_buyer: 0,
        rating_3_count_as_buyer: 0,
        rating_4_count_as_buyer: 0,
        rating_5_count_as_buyer: 0,
        updated_at: "2026-04-02T00:00:00.000Z",
      },
      reviews: {
        items: [],
        total: 0,
        count: 0,
      },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountReviewSummaryRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("North Store")).toBeTruthy();
    expect(screen.getByText("Received reviews")).toBeTruthy();
    expect(screen.getByText("Written reviews")).toBeTruthy();
  });
});
