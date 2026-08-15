import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card, Text } from "@chase-sets/design-system";
import { OrderingOrderDetailPage } from "./order-detail-page";

const order = {
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
  protection_amount: "0.20",
  protection_allowance_amount: "0.20",
  protection_overage_amount: "0.00",
  shipping_charge_amount: "4.99",
  sales_tax_amount: "1.75",
  taxable_amount: "24.99",
  total_amount: "26.74",
  marketplace_sales_fee_amount: "2.00",
  seller_net_amount: "18.00",
  seller_item_net_amount: "18.00",
  seller_payout_amount: "22.99",
  status: "pending-payment",
  pending_payment_at: null,
  payment_deadline_at: null,
  payment_deadline_policy: null,
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
  cancelled_at: null,
  ready_for_fulfillment_at: null,
  line_count: 1,
  total_quantity: 1,
  item_titles: ["Charizard"],
  lines: [
    {
      line_id: "line_1",
      listing_id: "lst_1",
      inventory_item_id: "inv_1",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::",
      item_title: "Charizard",
      item_subtitle: null,
      selected_options: [],
      product_summary: "Standard",
      unit_price_amount: "20.00",
      quantity: 1,
      line_total_amount: "20.00",
    },
  ],
  inventory_holds: [
    {
      hold_id: "hold_1",
      inventory_item_id: "inv_1",
      seller_account_id: "acc_seller",
      quantity: 1,
      status: "active",
      created_at: "2026-04-02T00:00:00.000Z",
      released_at: null,
    },
  ],
  money_timeline: {
    refunds: [],
    support_cases: [],
    refunded_amount: "0.00",
    currency_code: "USD",
  },
} as const;

describe("ordering order detail page", () => {
  it("renders an injected supplementary section without regressing payment actions", () => {
    const markup = renderToString(
      <OrderingOrderDetailPage
        role="buyer"
        backHref="/account/purchases"
        paymentHref="/account/payments/new?orderIds=ord_1"
        order={order as never}
        supplementarySectionTitle="Review"
        supplementarySection={
          <Card>
            <Text>Leave account review</Text>
          </Card>
        }
      />,
    );

    expect(markup).toContain("Review");
    expect(markup).toContain("Leave account review");
    expect(markup).toContain("Pay now");
    expect(markup).toContain('value="cancel-purchase"');
    expect(markup).toContain("Support reference");
    expect(markup).toContain("ord_1");
    expect(markup).toContain("ORD-TESTREF1");
    expect(markup).not.toContain("View fulfillment");
  });

  it("shows source support references and fulfillment links for committed ordering records", () => {
    const committedOrder = {
      ...order,
      status: "ready-for-fulfillment",
      source_reference_id: "chk_buy_1",
      ready_for_fulfillment_at: "2026-04-02T00:05:00.000Z",
    };

    const markup = renderToString(
      <OrderingOrderDetailPage
        role="buyer"
        backHref="/account/purchases"
        supportHref="/account/support?orderId=ord_1"
        fulfillmentHref="/account/shipments"
        order={committedOrder as never}
      />,
    );

    expect(markup).toContain("Support reference");
    expect(markup).toContain("chk_buy_1");
    expect(markup).toContain("View fulfillment");
    expect(markup).toContain('href="/account/shipments"');
    expect(markup).toContain('href="/account/support?orderId=ord_1"');
    expect(markup).toContain("Report a problem");
    expect(markup).not.toContain("role=buyer");
    expect(markup).not.toContain("Latest seller confirmation");
    expect(markup).not.toContain("pending seller activity");
  });

  it("shows payment deadline guidance for pending-payment orders", () => {
    const markup = renderToString(
      <OrderingOrderDetailPage
        role="buyer"
        backHref="/account/purchases"
        paymentHref="/account/payments/new?orderIds=ord_1"
        order={
          {
            ...order,
            payment_deadline_at: "2026-04-02T01:00:00.000Z",
            payment_deadline_policy: "ordering-payment-deadline-card-v1",
          } as never
        }
      />,
    );

    expect(markup).toContain("Complete payment by deadline");
    expect(markup).toContain("Complete payment by");
  });

  it("scopes the buyer breakdown to buyer-relevant money lines and hides seller economics", () => {
    const markup = renderToString(
      <OrderingOrderDetailPage role="buyer" backHref="/account/purchases" order={order as never} />,
    );

    // Buyer-relevant lines are present.
    expect(markup).toContain("Item subtotal");
    expect(markup).toContain("Shipping");
    expect(markup).toContain("Tax");
    expect(markup).toContain("$20.00");
    expect(markup).toContain("$4.99");
    expect(markup).toContain("$1.75");

    // Seller economics never render for the buyer.
    expect(markup).not.toContain("Marketplace sales fee");
    expect(markup).not.toContain("Seller item net");
    expect(markup).not.toContain("Seller payout");
    expect(markup).toContain("Every order includes Order Protection");
    expect(markup).toContain('href="/help/buying/order-protection"');
    expect(markup).toContain("Read Order Protection terms");
    expect(markup).not.toContain("$0.20");
    expect(markup).not.toContain("$2.00");
    expect(markup).not.toContain("$22.99");

    // Inventory holds are internal operational detail and never render for the buyer.
    expect(markup).not.toContain("Inventory Holds");
    expect(markup).not.toContain("Reserved item");
  });

  it("scopes the seller breakdown to seller economics and keeps inventory holds visible", () => {
    const markup = renderToString(
      <OrderingOrderDetailPage role="seller" backHref="/account/sales" order={order as never} />,
    );

    // Seller economics are present.
    expect(markup).toContain("Marketplace sales fee");
    expect(markup).toContain("Seller item net");
    expect(markup).toContain("Seller payout");
    expect(markup).toContain("Order protection");
    expect(markup).toContain("$0.20");
    expect(markup).toContain("$2.00");
    expect(markup).toContain("$18.00");
    expect(markup).toContain("$22.99");

    // The tax line rendered for the buyer role does not render here (shipping
    // allowance/overage takes its place in the seller's own economics).
    expect(markup).not.toContain("Tax");

    // Sellers keep visibility into inventory holds tied to their fulfillment.
    expect(markup).toContain("Inventory Holds");
    expect(markup).toContain("Reserved item");
    expect(markup).toContain(
      'class="surface-border min-w-0 max-w-full rounded-tokenLg ds-glass bg-elevated p-4 shadow-tokenLg ds-glow"',
    );
    expect(markup).toContain('class="min-w-0 max-w-full rounded-tokenLg border border-muted bg-elevated p-4"');
    expect(markup).toContain('class="min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4"');
  });

  it("shows refund progress and customer-safe issued and failed guidance to the buyer", () => {
    const markup = renderToString(
      <OrderingOrderDetailPage
        role="buyer"
        backHref="/account/purchases"
        order={
          {
            ...order,
            status: "ready-for-fulfillment",
            ready_for_fulfillment_at: "2026-07-14T00:00:00.000Z",
            money_timeline: {
              refunds: [
                {
                  refund_id: "rfd_issued",
                  amount: "8.00",
                  currency_code: "USD",
                  status: "issued",
                  requested_at: "2026-07-15T00:00:00.000Z",
                  issued_at: "2026-07-16T00:00:00.000Z",
                  failed_at: null,
                },
                {
                  refund_id: "rfd_failed",
                  amount: "2.00",
                  currency_code: "USD",
                  status: "failed",
                  requested_at: "2026-07-17T00:00:00.000Z",
                  issued_at: null,
                  failed_at: "2026-07-18T00:00:00.000Z",
                },
              ],
              support_cases: [
                {
                  support_request_id: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
                  status: "resolved",
                  resolution_type: "partial-refund",
                  refund_amount: "8.00",
                  active_hold: true,
                  opened_at: "2026-07-15T00:00:00.000Z",
                  resolved_at: "2026-07-16T00:00:00.000Z",
                  released_at: null,
                },
              ],
              refunded_amount: "8.00",
              currency_code: "USD",
            },
          } as never
        }
      />,
    );

    expect(markup).toContain("Money timeline");
    expect(markup).toContain("Paid");
    expect(markup).toContain("Refund requested");
    expect(markup).toContain("Refund issued");
    expect(markup).toContain("typically arrives in 5–10 business days");
    expect(markup).toContain("Refund needs attention");
    expect(markup).toContain("Support is on it");
    expect(markup).not.toContain("processor");
    expect(markup).toContain("SUP-");
  });

  it("shows active proceeds holds and refunded versus retained amounts to the seller", () => {
    const markup = renderToString(
      <OrderingOrderDetailPage
        role="seller"
        backHref="/account/sales"
        order={
          {
            ...order,
            total_amount: "26.74",
            money_timeline: {
              refunds: [],
              support_cases: [
                {
                  support_request_id: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
                  status: "resolved",
                  resolution_type: "partial-refund",
                  refund_amount: "8.00",
                  active_hold: true,
                  opened_at: "2026-07-15T00:00:00.000Z",
                  resolved_at: "2026-07-16T00:00:00.000Z",
                  released_at: null,
                },
              ],
              refunded_amount: "8.00",
              currency_code: "USD",
            },
          } as never
        }
      />,
    );

    expect(markup).toContain("Sale proceeds under support review");
    expect(markup).toContain("$22.99");
    expect(markup).toContain("released when the case closes");
    expect(markup).toContain("Refunded");
    expect(markup).toContain("$8.00");
    expect(markup).toContain("Retained");
    expect(markup).toContain("$18.74");
  });
});
