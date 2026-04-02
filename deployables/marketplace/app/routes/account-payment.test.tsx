import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import type { OrderingOrderDetail } from "@chase-sets/ordering/web";
import type { PaymentsPaymentDetail } from "@chase-sets/payments/web";

const { mockUseLoaderData, mockUseRevalidator } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseRevalidator: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useRevalidator: mockUseRevalidator,
  };
});

import MarketplaceAccountPaymentRoute from "./account-payment";

function buildOrder(overrides: Partial<OrderingOrderDetail> = {}): OrderingOrderDetail {
  return {
    order_id: "ord_1",
    source_type: "checkout",
    source_reference_id: "chk_1",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    item_subtotal_amount: "10.00",
    shipping_base_amount: "1.00",
    shipping_discount_amount: "0.00",
    shipping_charge_amount: "1.00",
    total_amount: "11.00",
    status: "pending-payment",
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    cancelled_at: null,
    ready_for_fulfillment_at: null,
    line_count: 1,
    total_quantity: 1,
    lines: [],
    inventory_holds: [],
    ...overrides,
  };
}

function buildPayment(overrides: Partial<PaymentsPaymentDetail> = {}): PaymentsPaymentDetail {
  return {
    payment_id: "pay_1",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "11.00",
    currency_code: "USD",
    processor_name: "stripe",
    processor_payment_reference: "pi_123",
    processor_client_secret: null,
    processor_status: "requires_payment_method",
    status: "pending-confirmation",
    failure_code: null,
    failure_message: null,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    captured_at: null,
    failed_at: null,
    cancelled_at: null,
    processor_publishable_key: null,
    ...overrides,
  };
}

describe("marketplace account payment route", () => {
  beforeEach(() => {
    mockUseRevalidator.mockReturnValue({
      revalidate: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete window.Stripe;
    document.head.innerHTML = "";
  });

  it("renders the captured payment summary and linked orders", () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
      }),
      orders: [
        buildOrder({
          status: "ready-for-fulfillment",
          ready_for_fulfillment_at: "2026-04-01T00:05:00.000Z",
        }),
      ],
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Payment pay_1")).toBeTruthy();
    expect(screen.getAllByText("captured").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Total: $11.00").length).toBe(2);
    expect(screen.getByText("Status: ready-for-fulfillment")).toBeTruthy();
    expect(screen.queryByText("Confirm payment")).toBeNull();
  });

  it("renders a retry path when Stripe reports a failed payment", () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "failed",
        processor_status: "requires_payment_method",
        failure_message: "Card was declined.",
        failed_at: "2026-04-01T00:04:00.000Z",
        order_ids: ["ord_1", "ord_2"],
      }),
      orders: [buildOrder(), buildOrder({ order_id: "ord_2" })],
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Card was declined.")).toBeTruthy();
    const retryLink = screen.getByRole("link", { name: "Retry payment" });
    expect(retryLink.getAttribute("href")).toBe(
      "/account/payments/new?orderIds=ord_1%2Cord_2",
    );
  });

  it("confirms a pending Stripe payment and revalidates afterward", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const confirmPayment = vi.fn().mockResolvedValue({});
    const revalidate = vi.fn();

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildOrder()],
    });

    window.Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
      })),
      confirmPayment,
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    const button = await screen.findByRole("button", {
      name: "Confirm payment",
    });

    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    await waitFor(() =>
      expect(confirmPayment).toHaveBeenCalledWith({
        elements: expect.any(Object),
        redirect: "if_required",
      }),
    );

    await waitFor(() => expect(revalidate).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(paymentElement.mount).toHaveBeenCalled();
  });
});
