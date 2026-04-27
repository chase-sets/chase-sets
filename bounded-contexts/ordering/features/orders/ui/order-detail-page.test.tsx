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
      inventory_record_id: "inv_1",
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
        backHref="/account/orders"
        paymentHref="/account/payments/new?orderIds=ord_1"
        order={order}
        supplementarySectionTitle="Review"
        supplementarySection={
          <Card>
            <Text>Leave seller review</Text>
          </Card>
        }
      />,
    );

    expect(markup).toContain("Review");
    expect(markup).toContain("Leave seller review");
    expect(markup).toContain("Pay now");
    expect(markup).toContain("Cancel order");
  });
});
