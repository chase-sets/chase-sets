import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { ReputationApiError } from "@chase-sets/reputation/web";

const {
  mockUseLoaderData,
  mockUseActionData,
  mockUseNavigation,
  mockRequireActorFromAuthApi,
  mockCreateReputationRequestApiClient,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
  mockCreateReputationRequestApiClient: vi.fn(),
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

vi.mock("@chase-sets/reputation/client", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/reputation/client")>(
    "@chase-sets/reputation/client",
  );

  return {
    ...actual,
    createReputationRequestApiClient: mockCreateReputationRequestApiClient,
  };
});

vi.mock("@chase-sets/auth-runtime", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/auth-runtime")>(
    "@chase-sets/auth-runtime",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

import MarketplaceAccountOrderReviewRoute, {
  action,
  loader,
} from "./account-order-review";

const opportunity = {
  order_id: "ord_1",
  subject_account_id: "acc_seller",
  subject_display_name: "Seller",
  author_role: "buyer",
  eligible_at: "2026-04-02T00:00:00.000Z",
  active_review_id: null,
};

describe("marketplace account order review route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["reputation.view", "reputation.manage"],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the verified-order opportunity", async () => {
    const getOrderReviewOpportunity = vi.fn().mockResolvedValue(opportunity);

    mockCreateReputationRequestApiClient.mockReturnValue({
      getOrderReviewOpportunity,
    });

    const result = await loader({
      request: new Request("http://localhost/account/orders/ord_1/review"),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(getOrderReviewOpportunity).toHaveBeenCalledWith("ord_1");
    expect(result.opportunity.subject_account_id).toBe("acc_seller");
  });

  it("refuses to open the review form for a non-verified order", async () => {
    const getOrderReviewOpportunity = vi
      .fn()
      .mockRejectedValue(new ReputationApiError(404, { error: "Review opportunity not found." }));

    mockCreateReputationRequestApiClient.mockReturnValue({
      getOrderReviewOpportunity,
    });

    await expect(
      loader({
        request: new Request("http://localhost/account/orders/ord_2/review"),
        params: { orderId: "ord_2" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("submits a buyer review and redirects to the new review page", async () => {
    const getOrderReviewOpportunity = vi.fn().mockResolvedValue(opportunity);
    const submitReview = vi.fn().mockResolvedValue({ id: "rev_1", version: 1 });

    mockCreateReputationRequestApiClient.mockReturnValue({
      getOrderReviewOpportunity,
      submitReview,
    });

    const form = new FormData();
    form.set("rating", "5");
    form.set("feedback", "Great seller.");

    const response = await action({
      request: new Request("http://localhost/account/orders/ord_1/review", {
        method: "POST",
        body: form,
      }),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(getOrderReviewOpportunity).toHaveBeenCalledWith("ord_1");
    expect(submitReview).toHaveBeenCalledWith({
      orderId: "ord_1",
      subjectAccountId: "acc_seller",
      rating: 5,
      feedback: "Great seller.",
    });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      throw new Error("Expected redirect response.");
    }
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/reviews/rev_1");
  });

  it("renders the buyer review submission page", () => {
    mockUseLoaderData.mockReturnValue({ opportunity });

    render(
      <ChaseRoot>
        <MarketplaceAccountOrderReviewRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Submit seller review")).toBeTruthy();
  });
});
