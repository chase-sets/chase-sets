import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { jsonResponse, requestUrl } from "./test-support/http";

const {
  mockUseLoaderData,
  mockUseActionData,
  mockRequireActorFromAuthApi,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useActionData: mockUseActionData,
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

import MarketplaceAccountOrderRoute, { loader } from "./account-order";

const order = {
  order_id: "ord_1",
  source_type: "cart-checkout",
  source_reference_id: null,
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Buyer",
  seller_account_id: "acc_seller",
  seller_display_name: "Seller",
  shipping_option: "standard",
  item_subtotal_amount: "20.00",
  shipping_base_amount: "4.99",
  shipping_discount_amount: "0.00",
  shipping_charge_amount: "4.99",
  total_amount: "24.99",
  status: "pending-payment",
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
  cancelled_at: null,
  ready_for_fulfillment_at: null,
  line_count: 1,
  total_quantity: 1,
  lines: [],
  inventory_holds: [],
};

describe("marketplace account order route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.view", "reputation.view", "reputation.manage"],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads the buyer order and matching review opportunity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/buyer/orders/ord_1")) {
          return Promise.resolve(jsonResponse(order));
        }

        if (url.includes("/api/marketplace/reviews/opportunities/orders/ord_1")) {
          return Promise.resolve(
            jsonResponse({
              order_id: "ord_1",
              subject_account_id: "acc_seller",
              subject_display_name: "Seller",
              author_role: "buyer",
              eligible_at: "2026-04-02T00:00:00.000Z",
              active_review_id: null,
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/orders/ord_1"),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.order.order_id).toBe("ord_1");
    expect(result.reviewOpportunity?.subject_account_id).toBe("acc_seller");
  });

  it("renders a verified-order review CTA for buyers", () => {
    mockUseLoaderData.mockReturnValue({
      order,
      reviewOpportunity: {
        order_id: "ord_1",
        subject_account_id: "acc_seller",
        subject_display_name: "Seller",
        author_role: "buyer",
        eligible_at: "2026-04-02T00:00:00.000Z",
        active_review_id: null,
      },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountOrderRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Leave seller review")).toBeTruthy();
  });

  it("hides the review CTA when the order is not verified for review", () => {
    mockUseLoaderData.mockReturnValue({
      order,
      reviewOpportunity: null,
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountOrderRoute />
      </ChaseRoot>,
    );

    expect(screen.queryByText("Leave seller review")).toBeNull();
  });
});
