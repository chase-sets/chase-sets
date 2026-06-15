// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";
import { jsonResponse, requestUrl } from "./test-support/http";

const { mockUseLoaderData, mockUseActionData, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
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

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

import MarketplaceAccountSaleRoute, { action, loader } from "../routes/account-sale";

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

const orderingCommit = {
  sourceContextName: "ordering",
  maxGlobalPosition: "43",
  eventIds: ["evt_sale_cancelled"],
};

describe("marketplace account sale route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["orders.view", "listings.view", "reputation.view", "reputation.manage"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads the sale and matching review opportunity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/account/sales/ord_1")) {
          return Promise.resolve(jsonResponse(order));
        }

        if (url.includes("/api/marketplace/reviews/opportunities/orders/ord_1")) {
          return Promise.resolve(
            jsonResponse({
              order_id: "ord_1",
              subject_account_id: "acc_buyer",
              subject_display_name: "Buyer",
              author_role: "seller",
              eligible_at: "2026-04-02T00:00:00.000Z",
              active_review_id: null,
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/sales/ord_1"),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.sale.order_id).toBe("ord_1");
    expect(result.reviewOpportunity?.subject_account_id).toBe("acc_buyer");
  });

  it("redirects sale cancellation with the Ordering commit receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/sales/ord_1/cancel")) {
          return Promise.resolve(
            jsonResponse({ id: "ord_1", version: 3, status: "cancelled" }, 200, {
              "Chase-Sets-Consistency": "committed",
              [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([orderingCommit]),
            }),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = await action({
      request: new Request("http://localhost/account/sales/ord_1", {
        method: "POST",
        body: new URLSearchParams({ intent: "cancel-sale" }),
      }),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toContain("afterWrite=");
  });

  it("renders a verified-sale counterparty review CTA", () => {
    mockUseLoaderData.mockReturnValue({
      sale: order,
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

    expect(screen.getByText("Leave account review")).toBeTruthy();
  });
});
