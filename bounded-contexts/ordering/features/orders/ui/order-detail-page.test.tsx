import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card, Text } from "@chase-sets/design-system";
import { OrderingOrderDetailPage } from "./order-detail-page";

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
  inventory_holds: [],
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
        supportHref="/account/support?orderId=ord_1&role=buyer"
        fulfillmentHref="/account/shipments"
        order={committedOrder as never}
      />,
    );

    expect(markup).toContain("Support reference");
    expect(markup).toContain("chk_buy_1");
    expect(markup).toContain("View fulfillment");
    expect(markup).toContain('href="/account/shipments"');
    expect(markup).not.toContain("Latest seller confirmation");
    expect(markup).not.toContain("pending seller activity");
  });
});
