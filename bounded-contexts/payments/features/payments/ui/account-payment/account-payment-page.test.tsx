// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import type { PaymentsPaymentDetail } from "../contracts";
import type { AccountPaymentOrderView, AccountPaymentPageProps } from "./account-payment-contracts";
import { AccountPaymentPage } from "./account-payment-page";

// Seller-side economics the buyer page must never show. Every buyer amount
// below is chosen distinct from these so an absence check cannot collide.
const sellerAmounts = ["$3.17", "$53.70", "$26.85"] as const;
const sellerLabels = ["Marketplace Sales Fee", "Seller payout"] as const;

function buildPayment(overrides: Partial<PaymentsPaymentDetail> = {}): PaymentsPaymentDetail {
  return {
    payment_id: "pay_8746",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_a", "ord_b"],
    amount: "57.32",
    balance_credit_amount: "7.32",
    processor_amount: "50.00",
    marketplace_sales_fee_amount: "3.17",
    marketplace_checkout_fee_amount: "2.45",
    marketplace_checkout_fee_policy_version: null,
    marketplace_checkout_fee_quote_fingerprint: null,
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "53.70",
    seller_payout_amount: "53.70",
    seller_payouts: [],
    currency_code: "USD",
    processor_name: "stripe",
    processor_payment_kind: "payment-intent",
    processor_payment_reference: "pi_8746",
    processor_client_secret: null,
    processor_redirect_url: null,
    processor_status: "succeeded",
    source_context: null,
    source_reference_id: null,
    status: "captured",
    failure_code: null,
    failure_message: null,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:05:00.000Z",
    captured_at: "2026-04-01T00:05:00.000Z",
    failed_at: null,
    cancelled_at: null,
    processor_publishable_key: null,
    provider_events: [],
    ...overrides,
  };
}

const orders: readonly AccountPaymentOrderView[] = [
  {
    order_id: "ord_a",
    status: "ready-for-fulfillment",
    total_amount: "30.00",
    seller_payout_amount: "26.85",
    payment_deadline_at: null,
  },
  {
    order_id: "ord_b",
    status: "shipped",
    total_amount: "27.32",
    seller_payout_amount: "26.85",
    payment_deadline_at: null,
  },
];

function renderPage(overrides: Partial<AccountPaymentPageProps> = {}) {
  const props: AccountPaymentPageProps = {
    payment: buildPayment(),
    orders,
    isGuestCheckoutPayment: false,
    showSupportDetails: false,
    paymentElementDefaultValues: null,
    retryActionError: null,
    guestClaimSection: null,
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <AccountPaymentPage {...props} /> }]);
  return render(
    <ChaseRoot>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}

// Both summary renders stay in the DOM: the mobile disclosure renders its
// children while collapsed and the desktop aside is only CSS-hidden.
function summaryScopes(container: HTMLElement) {
  const mobile = container.querySelector("details");
  const desktop = container.querySelector<HTMLElement>('aside[aria-label="Payment Summary"]');
  expect(mobile).toBeTruthy();
  expect(desktop).toBeTruthy();
  return { mobile: mobile as HTMLElement, desktop: desktop! };
}

function summaryRowValue(scope: HTMLElement, label: string) {
  const labels = within(scope).getAllByText(label, { selector: "span" });
  expect(labels).toHaveLength(1);
  return labels[0]!.nextElementSibling?.textContent;
}

function purchaseCard(orderId: string) {
  const card = screen.getByText(`Purchase ${orderId}`).closest<HTMLElement>(".min-w-0.max-w-full.rounded-tokenLg");
  expect(card).toBeTruthy();
  return card!;
}

describe("AccountPaymentPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows no seller fee or payout label or amount anywhere on the buyer page", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";

    expect(text).toContain("Payment Summary");
    for (const label of sellerLabels) expect(text).not.toContain(label);
    for (const amount of sellerAmounts) expect(text).not.toContain(amount);
  });

  it("keeps every buyer summary row and value in both summary renders", () => {
    const { container } = renderPage();

    for (const scope of Object.values(summaryScopes(container))) {
      expect(summaryRowValue(scope, "Status")).toBe("Paid");
      expect(summaryRowValue(scope, "Wallet balance used")).toBe("$7.32");
      expect(summaryRowValue(scope, "External payment")).toBe("$50.00");
      expect(summaryRowValue(scope, "Marketplace Checkout Fee")).toBe("$2.45");
      expect(summaryRowValue(scope, "Payment method")).toBe("card");
      expect(summaryRowValue(scope, "Processor")).toBe("stripe");
      expect(within(scope).getAllByText("$57.32").length).toBeGreaterThan(0);
    }
  });

  it("keeps each purchase card's order status, total and Open purchase link for a signed-in buyer", () => {
    renderPage();

    const first = purchaseCard("ord_a");
    expect(within(first).getByText("ready-for-fulfillment")).toBeTruthy();
    expect(within(first).getByText("Total").nextElementSibling?.textContent).toBe("$30.00");
    expect(within(first).getByRole("link", { name: "Open purchase" }).getAttribute("href")).toBe(
      "/account/purchases/ord_a",
    );

    const second = purchaseCard("ord_b");
    expect(within(second).getByText("shipped")).toBeTruthy();
    expect(within(second).getByText("Total").nextElementSibling?.textContent).toBe("$27.32");
    expect(within(second).getByRole("link", { name: "Open purchase" }).getAttribute("href")).toBe(
      "/account/purchases/ord_b",
    );

    expect(screen.getByRole("link", { name: "Back to purchases" }).getAttribute("href")).toBe("/account/purchases");
  });

  it("hides Back to purchases and Open purchase for a guest checkout payment", () => {
    renderPage({ isGuestCheckoutPayment: true });

    expect(screen.getByText("Purchase ord_a")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back to purchases" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open purchase" })).toBeNull();
  });

  it("still offers Retry payment on a failed payment", () => {
    renderPage({
      payment: buildPayment({
        status: "failed",
        processor_status: "requires_payment_method",
        captured_at: null,
        failed_at: "2026-04-01T00:05:00.000Z",
      }),
    });

    expect(screen.getByRole("link", { name: "Retry payment" }).getAttribute("href")).toBe(
      "/account/payments/new?orderIds=ord_a%2Cord_b",
    );
  });
});
