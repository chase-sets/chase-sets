// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { jsonResponse, requestUrl } from "./test-support/http";

const { mockUseLoaderData, mockUseActionData, mockUseNavigation, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useActionData: mockUseActionData,
    useNavigation: mockUseNavigation,
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
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle", formData: null });
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
        items: [
          {
            review_id: "rev_1",
            order_id: "ord_1",
            author_account_id: "acc_buyer",
            author_display_name: "Buyer account",
            subject_account_id: "acc_1",
            subject_display_name: "North Store",
            author_role: "buyer",
            rating: 5,
            feedback: "Packed carefully.",
            status: "active",
            submitted_at: "2026-04-02T00:00:00.000Z",
            updated_at: "2026-04-02T00:00:00.000Z",
            withdrawn_at: null,
            revealed_at: "2026-04-03T00:00:00.000Z",
            reveal_reason: "counterparty-submitted",
            held: false,
            withdrawn_by_actor_type: null,
            moderation_operator_user_id: null,
            moderation_reason: null,
            feedback_redacted_at: null,
            reply_id: "rvr_1",
            reply_feedback: "Thank you for the thoughtful review.",
            reply_status: "active",
            reply_submitted_at: "2026-04-04T00:00:00.000Z",
            reply_withdrawn_at: null,
          },
        ],
        total: 1,
        count: 1,
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
    expect(screen.getByText(/Account response/)).toBeTruthy();
    expect(screen.getByText("Thank you for the thoughtful review.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report review" })).toBeTruthy();
  });
});
