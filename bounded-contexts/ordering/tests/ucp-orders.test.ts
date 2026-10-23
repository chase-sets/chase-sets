import { describe, expect, it } from "vitest";
import { ucpSchemaValidator } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import { orderUcpResource } from "../support/ucp-support/orders";
import type { OrderingOrderDetailRow } from "../features/orders/read-model/queries";

function row(overrides: Partial<OrderingOrderDetailRow> = {}) {
  return {
    order_id: "ord_1",
    display_reference: "CS-0001",
    source_type: "buy-now",
    source_reference_id: "chk_1",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    item_subtotal_amount: "20.00",
    shipping_base_amount: "5.00",
    shipping_discount_amount: "0.00",
    shipping_allowance_amount: "0.00",
    shipping_overage_amount: "0.00",
    protection_amount: "0.00",
    protection_allowance_amount: "0.00",
    protection_overage_amount: "0.00",
    shipping_charge_amount: "5.00",
    sales_tax_amount: "2.00",
    taxable_amount: "20.00",
    tax_jurisdiction_country: "US",
    tax_jurisdiction_state: "IL",
    tax_rate_bps: 1000,
    tax_provider_name: "synthetic",
    tax_provider_quote_reference: "quote_1",
    tax_quoted_at: "2026-10-16T00:00:00Z",
    total_amount: "27.00",
    marketplace_sales_fee_amount: "0.00",
    seller_net_amount: "20.00",
    seller_item_net_amount: "20.00",
    seller_payout_amount: "20.00",
    shipping_allowance_percentage_bps: 0,
    terms_schedule_id: null,
    terms_agreement_id: null,
    terms_resolved_at: "2026-10-16T00:00:00Z",
    shipping_destination_snapshot: {
      name: "Buyer",
      line1: "1 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    shipping_origin_snapshot: {
      name: "Seller",
      line1: "2 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60602",
      country: "US",
    },
    status: "pending-payment",
    pending_payment_at: null,
    payment_deadline_at: null,
    payment_deadline_policy: null,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    cancelled_at: null,
    cancellation_reason: null,
    ready_for_fulfillment_at: null,
    self_service_cancellation_available: false,
    cancellation_unavailable_reason: null,
    line_count: 1,
    total_quantity: 1,
    item_titles: ["Charizard"],
    lines: [
      {
        line_id: "line_1",
        listing_id: "lst_1",
        inventory_item_id: "inv_1",
        catalog_catalog_item_id: "cat_1",
        product_id: "prod_1",
        item_title: "Charizard",
        item_subtitle: null,
        selected_options: [],
        product_summary: "Raw",
        unit_price_amount: "20.00",
        quantity: 1,
        line_total_amount: "20.00",
        marketplace_sales_fee_percentage_bps: 0,
        marketplace_sales_fee_fixed_amount: "0.00",
        marketplace_sales_fee_cap_amount: null,
        marketplace_sales_fee_unit_amount: "0.00",
        marketplace_sales_fee_total_amount: "0.00",
        seller_net_unit_amount: "20.00",
        seller_net_total_amount: "20.00",
        listing_evidence_gallery: [],
      },
    ],
    inventory_holds: [],
    money_timeline: { refunds: [], support_cases: [], refunded_amount: "0.00", currency_code: "USD" },
    ...overrides,
  } as OrderingOrderDetailRow;
}

describe("UCP 2026-08-25 Order resource", () => {
  const validate = ucpSchemaValidator("https://ucp.dev/2026-08-25/schemas/shopping/order.json");
  const request = new Request("https://marketplace.example/ucp/v1/orders/ord_1");

  it("UCP 2026-08-25 Order resource validates, including cancelled", () => {
    for (const perspective of ["purchase", "sale"] as const) {
      for (const cancelled of [false, true]) {
        const resource = orderUcpResource(
          row(
            cancelled
              ? { status: "cancelled", cancelled_at: "2026-10-16T02:00:00Z", cancellation_reason: "Buyer requested" }
              : { ready_for_fulfillment_at: "2026-10-16T01:00:00Z" },
          ),
          perspective,
          request,
        );
        expect(
          validate({ ...resource, ucp: { version: "2026-08-25", status: "success" } }),
          JSON.stringify(validate.errors),
        ).toBe(true);
        expect(resource.permalink_url).toBe(
          `https://marketplace.example/account/${perspective === "purchase" ? "purchases" : "sales"}/ord_1`,
        );
        expect(new URL(resource.permalink_url).origin).toBe("https://marketplace.example");
        expect(resource.line_items[0]!.item.id).toBe("prod_1");
        expect(resource.line_items[0]!.status).toBe(cancelled ? "removed" : "fulfilled");
        if (cancelled) {
          expect(resource.line_items[0]!.quantity).toEqual({ original: 1, total: 0, fulfilled: 0 });
          expect(resource.adjustments).toEqual([
            {
              id: "cancellation_ord_1",
              type: "cancellation",
              occurred_at: "2026-10-16T02:00:00Z",
              status: "completed",
              description: "Buyer requested",
            },
          ]);
        }
        console.info(
          "AC2_ORDER",
          JSON.stringify({ perspective, cancelled, valid: true, permalink_url: resource.permalink_url }),
        );
      }
    }
  });
});
