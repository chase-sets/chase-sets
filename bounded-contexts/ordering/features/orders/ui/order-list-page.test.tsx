import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderingOrderListPage } from "./order-list-page";
import type { PurchaseListItem, SaleListItem } from "./contracts";

function buildOrder(overrides: Partial<PurchaseListItem & SaleListItem> = {}): PurchaseListItem & SaleListItem {
  return {
    order_id: "ord_1",
    display_reference: "ORD-TESTREF1",
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
    shipping_allowance_amount: "4.99",
    shipping_overage_amount: "0.00",
    shipping_charge_amount: "4.99",
    sales_tax_amount: "1.75",
    total_amount: "26.74",
    marketplace_sales_fee_amount: "2.00",
    seller_net_amount: "18.00",
    seller_item_net_amount: "18.00",
    seller_payout_amount: "22.99",
    shipping_allowance_percentage_bps: 500,
    taxable_amount: "24.99",
    tax_jurisdiction_country: "US",
    tax_jurisdiction_state: null,
    tax_rate_bps: 700,
    tax_provider_name: "local-stub",
    tax_provider_quote_reference: null,
    tax_quoted_at: "2026-04-02T00:00:00.000Z",
    terms_schedule_id: null,
    terms_agreement_id: null,
    terms_resolved_at: "2026-04-02T00:00:00.000Z",
    shipping_destination_snapshot: {} as never,
    shipping_origin_snapshot: {} as never,
    status: "pending-payment",
    pending_payment_at: null,
    payment_deadline_at: null,
    payment_deadline_policy: null,
    created_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    cancelled_at: null,
    cancellation_reason: null,
    ready_for_fulfillment_at: null,
    self_service_cancellation_available: true,
    cancellation_unavailable_reason: null,
    line_count: 1,
    total_quantity: 1,
    item_titles: ["Charizard"],
    ...overrides,
  };
}

describe("ordering order list page", () => {
  it("shows purchase cards with item titles and dates but never seller payout", () => {
    const markup = renderToString(
      <OrderingOrderListPage
        title="Purchases"
        eyebrow="Buyer"
        emptyTitle="No purchases yet"
        emptyDescription="Your checkout activity will appear here."
        orderDetailBasePath="/account/purchases"
        kind="purchase"
        orders={[buildOrder()]}
      />,
    );

    expect(markup).toContain("Charizard");
    expect(markup).toContain("Purchase");
    expect(markup).toContain("ORD-TESTREF1");
    expect(markup).not.toContain("Seller payout");
    expect(markup).not.toContain("$22.99");
    expect(markup).toContain('class="min-w-0 max-w-full rounded-tokenLg border border-muted bg-elevated p-4"');
  });

  it("shows sale cards with seller payout since the seller is viewing their own economics", () => {
    const markup = renderToString(
      <OrderingOrderListPage
        title="Sales"
        eyebrow="Seller"
        emptyTitle="No sales yet"
        emptyDescription="Accepted offers and checkout activity create sales."
        orderDetailBasePath="/account/sales"
        kind="sale"
        orders={[buildOrder()]}
      />,
    );

    expect(markup).toContain("Charizard");
    expect(markup).toContain("Sale");
    expect(markup).toContain("Seller payout");
    expect(markup).toContain("$22.99");
  });

  it("summarizes multiple line items on a card instead of a generic label", () => {
    const markup = renderToString(
      <OrderingOrderListPage
        title="Purchases"
        eyebrow="Buyer"
        emptyTitle="No purchases yet"
        emptyDescription="Your checkout activity will appear here."
        orderDetailBasePath="/account/purchases"
        kind="purchase"
        orders={[buildOrder({ item_titles: ["Charizard", "Blastoise", "Venusaur"] })]}
      />,
    );

    expect(markup).toContain("Charizard");
    expect(markup).toContain("+2 more");
  });

  it("does not infer purchase vs sale from a localized page title", () => {
    // Regression guard: the page title for a sale route could legitimately contain
    // the word "sale" in a future locale, or a purchase title could not. Labeling
    // must come from the explicit `kind` prop, never from sniffing `title`.
    const markup = renderToString(
      <OrderingOrderListPage
        title="On Sale Purchases"
        eyebrow="Buyer"
        emptyTitle="No purchases yet"
        emptyDescription="Your checkout activity will appear here."
        orderDetailBasePath="/account/purchases"
        kind="purchase"
        orders={[buildOrder()]}
      />,
    );

    expect(markup).not.toContain("Seller payout");
  });
});
