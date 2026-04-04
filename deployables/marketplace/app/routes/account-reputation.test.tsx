import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";

const {
  mockUseLoaderData,
  mockRequireActorFromAuthApi,
  mockCreateReputationRequestApiClient,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
  mockCreateReputationRequestApiClient: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
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

import MarketplaceAccountReputationRoute, { loader } from "./account-reputation";

describe("marketplace account reputation route", () => {
  beforeEach(() => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_1",
      permissions: ["reputation.view"],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the current account summary and public reviews", async () => {
    const getAccountReputation = vi.fn().mockResolvedValue({
      account_id: "acc_1",
      account_display_name: "North Store",
      average_rating: "4.75",
      review_count: 8,
      rating_1_count: 0,
      rating_2_count: 0,
      rating_3_count: 1,
      rating_4_count: 2,
      rating_5_count: 5,
      updated_at: "2026-04-02T00:00:00.000Z",
    });
    const listAccountReviews = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      count: 0,
    });

    mockCreateReputationRequestApiClient.mockReturnValue({
      getAccountReputation,
      listAccountReviews,
    });

    const result = await loader({
      request: new Request("http://localhost/account/reputation"),
      params: {},
      context: undefined,
    } as never);

    expect(getAccountReputation).toHaveBeenCalledWith("acc_1");
    expect(listAccountReviews).toHaveBeenCalledWith("acc_1", "limit=10&offset=0");
    expect(result.summary.account_display_name).toBe("North Store");
  });

  it("renders summary links for written and received reviews", () => {
    mockUseLoaderData.mockReturnValue({
      summary: {
        account_id: "acc_1",
        account_display_name: "North Store",
        average_rating: "4.75",
        review_count: 8,
        rating_1_count: 0,
        rating_2_count: 0,
        rating_3_count: 1,
        rating_4_count: 2,
        rating_5_count: 5,
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
        <MarketplaceAccountReputationRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("North Store")).toBeTruthy();
    expect(screen.getByText("Received reviews")).toBeTruthy();
    expect(screen.getByText("Written reviews")).toBeTruthy();
  });
});
