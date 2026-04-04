import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";

const {
  mockUseLoaderData,
  mockUseActionData,
  mockRequireActorFromIdentityApi,
  mockCreateOrderingRequestApiClient,
  mockCreateReputationRequestApiClient,
} = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockRequireActorFromIdentityApi: vi.fn(),
  mockCreateOrderingRequestApiClient: vi.fn(),
  mockCreateReputationRequestApiClient: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useActionData: mockUseActionData,
  };
});

vi.mock("@chase-sets/ordering/client", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/ordering/client")>(
    "@chase-sets/ordering/client",
  );

  return {
    ...actual,
    createOrderingRequestApiClient: mockCreateOrderingRequestApiClient,
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

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>(
    "@chase-sets/identity/server",
  );

  return {
    ...actual,
    requireActorFromIdentityApi: mockRequireActorFromIdentityApi,
  };
});

import MarketplaceAccountSaleRoute, { loader } from "./account-sale";

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
  status: "ready-for-fulfillment",
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
  cancelled_at: null,
  ready_for_fulfillment_at: "2026-04-02T00:15:00.000Z",
  line_count: 1,
  total_quantity: 1,
  lines: [],
  inventory_holds: [],
};

describe("marketplace account sale route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockRequireActorFromIdentityApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: [
        "orders.view",
        "listings.view",
        "reputation.view",
        "reputation.manage",
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the seller order and matching review opportunity", async () => {
    const getSellerOrder = vi.fn().mockResolvedValue(order);
    const getOrderReviewOpportunity = vi.fn().mockResolvedValue({
      order_id: "ord_1",
      subject_account_id: "acc_buyer",
      subject_display_name: "Buyer",
      author_role: "seller",
      eligible_at: "2026-04-02T00:00:00.000Z",
      active_review_id: null,
    });

    mockCreateOrderingRequestApiClient.mockReturnValue({ getSellerOrder });
    mockCreateReputationRequestApiClient.mockReturnValue({
      getOrderReviewOpportunity,
    });

    const result = await loader({
      request: new Request("http://localhost/account/sales/ord_1"),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(getSellerOrder).toHaveBeenCalledWith("ord_1");
    expect(getOrderReviewOpportunity).toHaveBeenCalledWith("ord_1");
    expect(result.reviewOpportunity?.subject_account_id).toBe("acc_buyer");
  });

  it("renders a verified-order review CTA for sellers", () => {
    mockUseLoaderData.mockReturnValue({
      order,
      reviewOpportunity: {
        order_id: "ord_1",
        subject_account_id: "acc_buyer",
        subject_display_name: "Buyer",
        author_role: "seller",
        eligible_at: "2026-04-02T00:00:00.000Z",
        active_review_id: null,
      },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountSaleRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Leave buyer review")).toBeTruthy();
  });
});
