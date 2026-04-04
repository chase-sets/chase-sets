import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";

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

import MarketplaceAccountSaleReviewRoute, {
  action,
  loader,
} from "./account-sale-review";

const opportunity = {
  order_id: "ord_1",
  subject_account_id: "acc_buyer",
  subject_display_name: "Buyer",
  author_role: "seller",
  eligible_at: "2026-04-02T00:00:00.000Z",
  active_review_id: null,
};

describe("marketplace account sale review route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["reputation.view", "reputation.manage"],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the seller-side verified-order opportunity", async () => {
    const getOrderReviewOpportunity = vi.fn().mockResolvedValue(opportunity);

    mockCreateReputationRequestApiClient.mockReturnValue({
      getOrderReviewOpportunity,
    });

    const result = await loader({
      request: new Request("http://localhost/account/sales/ord_1/review"),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.opportunity.subject_account_id).toBe("acc_buyer");
  });

  it("submits a seller review and redirects to the new review page", async () => {
    const getOrderReviewOpportunity = vi.fn().mockResolvedValue(opportunity);
    const submitReview = vi.fn().mockResolvedValue({ id: "rev_2", version: 1 });

    mockCreateReputationRequestApiClient.mockReturnValue({
      getOrderReviewOpportunity,
      submitReview,
    });

    const form = new FormData();
    form.set("rating", "4");
    form.set("feedback", "Prompt buyer.");

    const response = await action({
      request: new Request("http://localhost/account/sales/ord_1/review", {
        method: "POST",
        body: form,
      }),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(submitReview).toHaveBeenCalledWith({
      orderId: "ord_1",
      subjectAccountId: "acc_buyer",
      rating: 4,
      feedback: "Prompt buyer.",
    });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      throw new Error("Expected redirect response.");
    }
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/reviews/rev_2");
  });

  it("renders the seller review submission page", () => {
    mockUseLoaderData.mockReturnValue({ opportunity });

    render(
      <ChaseRoot>
        <MarketplaceAccountSaleReviewRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Submit buyer review")).toBeTruthy();
  });
});
